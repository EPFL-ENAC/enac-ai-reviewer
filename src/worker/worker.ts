import { writeFile } from 'node:fs/promises';
import pino from 'pino';
import { claimJob, completeJob, failJob, insertJobTrace, killJob, requeueStaleRunningJobs } from '../db/jobs.js';
import { createPool } from '../db/pool.js';
import { loadWorkerConfig } from '../domain/config.js';
import type { ReviewJob } from '../domain/types.js';
import { setAcknowledgmentReaction } from '../github/acknowledge.js';
import { createGithubApp, getInstallationOctokitForRepo } from '../github/auth.js';
import { isPermanentGithubError } from '../github/classify-error.js';
import { createLlmModel } from '../llm/client.js';
import { runJob } from './run-job.js';

const POLL_INTERVAL_MS = 1500;
const POLL_JITTER_MS = 500;
const HEARTBEAT_INTERVAL_MS = 5000;
const STALE_JOB_MAX_AGE_MINUTES = 10;
const HEARTBEAT_FILE = process.env.WORKER_HEARTBEAT_FILE ?? '/tmp/worker-heartbeat';

const config = loadWorkerConfig();
const sql = createPool(config.DATABASE_URL);
const githubApp = createGithubApp(config.GITHUB_APP_ID, config.GITHUB_PRIVATE_KEY);
const llmModel = createLlmModel(config.LLM_BASE_URL, config.LLM_API_KEY, config.LLM_MODEL);
const logger = pino();

let shuttingDown = false;
let heartbeatInterval: ReturnType<typeof setInterval> | undefined;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function touchHeartbeat(): Promise<void> {
  try {
    await writeFile(HEARTBEAT_FILE, String(Date.now()));
  } catch (err) {
    logger.warn({ err }, 'failed to write worker heartbeat file');
  }
}

const MAX_ERROR_DEPTH = 3;
const MAX_ERROR_STRING_LENGTH = 500;

function truncateForLogs(value: string): string {
  return value.length > MAX_ERROR_STRING_LENGTH ? `${value.slice(0, MAX_ERROR_STRING_LENGTH)}…` : value;
}

function serializeError(err: unknown, depth = 0): unknown {
  if (typeof err === 'string') return truncateForLogs(err);
  if (err === null || typeof err !== 'object' || Array.isArray(err)) return err;
  if (depth >= MAX_ERROR_DEPTH) return String(err);

  const source = err as { name?: string; message?: string; stack?: string; cause?: unknown } & Record<string, unknown>;
  const serialized: Record<string, unknown> = {
    name: source.name ?? source.constructor?.name ?? typeof err,
    message: source.message,
  };
  if (typeof source.stack === 'string') serialized.stack = source.stack;
  for (const key of ['status', 'statusCode', 'code', 'url', 'requestId']) {
    if (source[key] !== undefined) serialized[key] = source[key];
  }
  if (typeof source.responseBody === 'string') serialized.responseBody = truncateForLogs(source.responseBody);
  if (typeof source.request === 'object' && source.request !== null) {
    const { method, url } = source.request as { method?: unknown; url?: unknown };
    if (method !== undefined || url !== undefined) serialized.request = { method, url };
  }
  if (source.cause !== undefined) serialized.cause = serializeError(source.cause, depth + 1);
  return serialized;
}

async function updateAcknowledgment(job: ReviewJob, content: '+1' | '-1'): Promise<void> {
  try {
    const octokit = await getInstallationOctokitForRepo(githubApp, job.repositoryFullName);
    const payload = (job.payload ?? null) as { comment?: { id?: number } } | null;
    const commentId = typeof payload?.comment?.id === 'number' ? payload.comment.id : undefined;
    await setAcknowledgmentReaction(
      octokit,
      job.repositoryFullName,
      {
        commentId,
        issueNumber: job.issueNumber ?? undefined,
        changeRequestNumber: job.changeRequestNumber ?? undefined,
      },
      config.GITHUB_BOT_LOGIN,
      content,
    );
  } catch (err) {
    logger.warn({ jobId: job.id, content, err: serializeError(err) }, 'failed to update acknowledgment reaction');
  }
}

async function tick(): Promise<void> {
  const job = await claimJob(sql);
  if (!job) return;

  const startedAt = Date.now();
  const jobContext = { jobId: job.id, jobType: job.type, repositoryFullName: job.repositoryFullName };
  logger.info({ ...jobContext, attempts: job.attempts }, 'claimed job');

  try {
    await runJob({ sql, githubApp, config, logger, llmModel }, job);
    await completeJob(sql, job.id);
    await insertJobTrace(sql, { jobId: job.id, type: 'job_completed' });
    logger.info({ ...jobContext, durationMs: Date.now() - startedAt }, 'job completed');
    if (job.attempts > 1) await updateAcknowledgment(job, '+1');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const permanent = isPermanentGithubError(err);
    const failureContext = {
      ...jobContext,
      attempts: job.attempts,
      durationMs: Date.now() - startedAt,
      message,
      permanent,
      err: serializeError(err),
    };

    logger[permanent ? 'error' : 'warn'](failureContext, 'job failed');

    try {
      await insertJobTrace(sql, { jobId: job.id, type: 'job_failed', payload: { message, permanent } });
    } catch (traceErr) {
      logger.error({ jobId: job.id, err: serializeError(traceErr) }, 'failed to record job_failed trace');
    }

    if (permanent) {
      await killJob(sql, job.id, message);
    } else {
      await failJob(sql, job.id, message);
    }
    await updateAcknowledgment(job, '-1');
  }
}

async function loop(): Promise<void> {
  while (!shuttingDown) {
    try {
      await tick();
    } catch (err) {
      logger.error({ err }, 'worker tick failed unexpectedly');
    }
    await sleep(POLL_INTERVAL_MS + Math.floor(Math.random() * POLL_JITTER_MS));
  }
}

async function shutdown(reason: string): Promise<void> {
  logger.info('shutting down worker: %s', reason);
  shuttingDown = true;
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }
  await sql.end();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown("SIGTERM received"));
process.on('SIGINT', () => void shutdown("SIGINT received"));
process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'unhandled rejection in worker');
});

async function start(): Promise<void> {
  // Keep the heartbeat file fresh even when a single job (e.g. an LLM call)
  // blocks the poll loop for longer than the liveness-probe threshold.
  heartbeatInterval = setInterval(() => void touchHeartbeat(), HEARTBEAT_INTERVAL_MS);

  // If a previous worker died mid-job, those rows are still 'running'.
  // Re-queue them so work is not lost after a pod restart.
  try {
    const requeuedCount = await requeueStaleRunningJobs(sql, STALE_JOB_MAX_AGE_MINUTES);
    if (requeuedCount > 0) {
      logger.info({ requeuedCount }, 'requeued stale running jobs after worker startup');
    }
  } catch (err) {
    logger.error({ err }, 'failed to requeue stale running jobs; continuing poll loop');
  }

  void loop();
}

void start();
