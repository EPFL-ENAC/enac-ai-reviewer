import { writeFile } from 'node:fs/promises';
import pino from 'pino';
import { claimJob, completeJob, failJob, insertJobTrace, killJob, requeueStaleRunningJobs } from '../db/jobs.js';
import { createPool } from '../db/pool.js';
import { loadWorkerConfig } from '../domain/config.js';
import { createGithubApp } from '../github/auth.js';
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

async function tick(): Promise<void> {
  const job = await claimJob(sql);
  if (!job) return;

  logger.info({ jobId: job.id, jobType: job.type, repositoryFullName: job.repositoryFullName }, 'claimed job');

  try {
    await runJob({ sql, githubApp, config, logger, llmModel }, job);
    await completeJob(sql, job.id);
    await insertJobTrace(sql, { jobId: job.id, type: 'job_completed' });
    logger.info({ jobId: job.id }, 'job completed');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await insertJobTrace(sql, { jobId: job.id, type: 'job_failed', payload: { message, permanent: isPermanentGithubError(err) } });
    if (isPermanentGithubError(err)) {
      await killJob(sql, job.id, message);
      logger.error({ jobId: job.id, err: message }, 'job permanently failed');
    } else {
      await failJob(sql, job.id, message);
      logger.warn({ jobId: job.id, err: message, attempts: job.attempts }, 'job failed, may retry');
    }
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
  const requeuedCount = await requeueStaleRunningJobs(sql, STALE_JOB_MAX_AGE_MINUTES);
  if (requeuedCount > 0) {
    logger.info({ requeuedCount }, 'requeued stale running jobs after worker startup');
  }

  void loop();
}

void start();
