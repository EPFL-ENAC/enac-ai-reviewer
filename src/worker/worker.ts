import { writeFile } from 'node:fs/promises';
import pino from 'pino';
import { claimJob, completeJob, failJob, killJob } from '../db/jobs.js';
import { createPool } from '../db/pool.js';
import { loadWorkerConfig } from '../domain/config.js';
import { createGithubApp } from '../github/auth.js';
import { isPermanentGithubError } from '../github/classify-error.js';
import { runJob } from './run-job.js';

const POLL_INTERVAL_MS = 1500;
const POLL_JITTER_MS = 500;
const HEARTBEAT_FILE = process.env.WORKER_HEARTBEAT_FILE ?? '/tmp/worker-heartbeat';

const config = loadWorkerConfig();
const sql = createPool(config.DATABASE_URL);
const githubApp = createGithubApp(config.GITHUB_APP_ID, config.GITHUB_PRIVATE_KEY);
const logger = pino();

let shuttingDown = false;

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
  await touchHeartbeat();

  const job = await claimJob(sql);
  if (!job) return;

  logger.info({ jobId: job.id, jobType: job.type, repositoryFullName: job.repositoryFullName }, 'claimed job');

  try {
    await runJob({ sql, githubApp, config, logger }, job);
    await completeJob(sql, job.id);
    logger.info({ jobId: job.id }, 'job completed');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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

async function shutdown(): Promise<void> {
  logger.info('shutting down worker');
  shuttingDown = true;
  await sql.end();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

void loop();
