import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, type Sql } from './pool.js';
import {
  cancelJob,
  claimJob,
  completeJob,
  countJobs,
  countJobsByStatus,
  enqueueJob,
  failJob,
  getJobById,
  getJobTraces,
  insertDelivery,
  insertJobTrace,
  killJob,
  listJobs,
  requeueStaleRunningJobs,
  retryJob,
} from './jobs.js';
import type { NewReviewJob } from '../domain/types.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL must be set to run db tests (see docker-compose.yml)');
}

const sql: Sql = createPool(databaseUrl);

afterAll(async () => {
  await sql.end();
});

beforeEach(async () => {
  await sql`truncate job_traces, llm_usage, review_jobs, webhook_deliveries`;
});

function job(overrides: Partial<NewReviewJob> = {}): NewReviewJob {
  return {
    provider: 'github',
    type: 'issue_triage',
    repositoryFullName: 'EPFL-ENAC/co2-calculator',
    issueNumber: 42,
    triggerActor: 'guilbep',
    dedupeKey: 'github:EPFL-ENAC/co2-calculator:issue_triage:42:comment-1',
    payload: { foo: 'bar' },
    ...overrides,
  };
}

describe('insertDelivery', () => {
  it('records a new delivery id', async () => {
    const inserted = await insertDelivery(sql, { deliveryId: 'd1', event: 'issues' });
    expect(inserted).toBe(true);
  });

  it('rejects a duplicate delivery id', async () => {
    await insertDelivery(sql, { deliveryId: 'd1', event: 'issues' });
    const second = await insertDelivery(sql, { deliveryId: 'd1', event: 'issues' });
    expect(second).toBe(false);
  });
});

describe('enqueueJob', () => {
  it('inserts a queued job', async () => {
    const result = await enqueueJob(sql, job());
    expect(result).not.toBeNull();
    expect(result?.status).toBe('queued');
    expect(result?.dedupeKey).toBe('github:EPFL-ENAC/co2-calculator:issue_triage:42:comment-1');
  });

  it('does not create a duplicate job for the same dedupe key', async () => {
    await enqueueJob(sql, job());
    const second = await enqueueJob(sql, job());
    expect(second).toBeNull();

    const rows = await sql`select count(*)::int as count from review_jobs`;
    expect(rows[0]?.count).toBe(1);
  });
});

describe('claimJob', () => {
  it('returns null when no job is queued', async () => {
    const claimed = await claimJob(sql);
    expect(claimed).toBeNull();
  });

  it('claims the oldest queued job and marks it running', async () => {
    await enqueueJob(sql, job({ dedupeKey: 'k1' }));
    const claimed = await claimJob(sql);
    expect(claimed?.status).toBe('running');
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.startedAt).not.toBeNull();
  });

  it('does not let two concurrent claimers take the same job', async () => {
    await enqueueJob(sql, job({ dedupeKey: 'k1' }));

    const [a, b] = await Promise.all([claimJob(sql), claimJob(sql)]);
    const claimed = [a, b].filter((x) => x !== null);
    expect(claimed).toHaveLength(1);
  });
});

describe('completeJob / failJob', () => {
  it('marks a job done', async () => {
    const created = await enqueueJob(sql, job({ dedupeKey: 'k1' }));
    await claimJob(sql);
    await completeJob(sql, created!.id);

    const rows = await sql`select status, finished_at from review_jobs where id = ${created!.id}`;
    expect(rows[0]?.status).toBe('done');
    expect(rows[0]?.finished_at).not.toBeNull();
  });

  it('re-queues a failed job while attempts remain', async () => {
    const created = await enqueueJob(sql, job({ dedupeKey: 'k1' }));
    await claimJob(sql); // attempts -> 1, max_attempts default 3
    await failJob(sql, created!.id, 'boom');

    const rows = await sql`select status, error_message, attempts from review_jobs where id = ${created!.id}`;
    expect(rows[0]?.status).toBe('queued');
    expect(rows[0]?.error_message).toBe('boom');
    expect(rows[0]?.attempts).toBe(1);
  });

  it('marks a job dead once attempts are exhausted', async () => {
    const created = await enqueueJob(sql, job({ dedupeKey: 'k1' }));
    for (let i = 0; i < 3; i++) {
      await claimJob(sql);
      await failJob(sql, created!.id, `attempt ${i}`);
    }

    const rows = await sql`select status from review_jobs where id = ${created!.id}`;
    expect(rows[0]?.status).toBe('dead');
  });

  it('killJob marks a job dead immediately, ignoring remaining attempts', async () => {
    const created = await enqueueJob(sql, job({ dedupeKey: 'k1' }));
    await claimJob(sql); // attempts -> 1 of 3, would normally still be retryable
    await killJob(sql, created!.id, 'permanent auth failure');

    const rows = await sql`select status, error_message, attempts from review_jobs where id = ${created!.id}`;
    expect(rows[0]?.status).toBe('dead');
    expect(rows[0]?.error_message).toBe('permanent auth failure');
    expect(rows[0]?.attempts).toBe(1);
  });
});

describe('requeueStaleRunningJobs', () => {
  it('re-queues running jobs older than the threshold', async () => {
    const created = await enqueueJob(sql, job({ dedupeKey: 'k1' }));
    await claimJob(sql);

    // Simulate the job having been started 15 minutes ago.
    await sql`update review_jobs set started_at = now() - interval '15 minutes' where id = ${created!.id}`;

    const requeued = await requeueStaleRunningJobs(sql, 10);
    expect(requeued).toBe(1);

    const rows = await sql`select status, started_at, error_message from review_jobs where id = ${created!.id}`;
    expect(rows[0]?.status).toBe('queued');
    expect(rows[0]?.started_at).toBeNull();
    expect(rows[0]?.error_message).toBe('requeued after worker restart');
  });

  it('does not re-queues recently started running jobs', async () => {
    await enqueueJob(sql, job({ dedupeKey: 'k1' }));
    await claimJob(sql);

    const requeued = await requeueStaleRunningJobs(sql, 10);
    expect(requeued).toBe(0);
  });
});

describe('insertJobTrace / getJobTraces', () => {
  it('records trace events for a job in chronological order', async () => {
    const created = await enqueueJob(sql, job({ dedupeKey: 'k1' }));

    await insertJobTrace(sql, { jobId: created!.id, type: 'job_started', payload: { step: 1 } });
    await insertJobTrace(sql, { jobId: created!.id, type: 'llm_prompt', payload: { prompt: 'hello' } });

    const traces = await getJobTraces(sql, created!.id);
    expect(traces).toHaveLength(2);
    expect(traces[0]?.type).toBe('job_started');
    expect(traces[1]?.type).toBe('llm_prompt');
    expect((traces[1]?.payload as { prompt: string }).prompt).toBe('hello');
  });
});

describe('listJobs / countJobs / countJobsByStatus', () => {
  it('returns jobs ordered by creation time', async () => {
    const first = await enqueueJob(sql, job({ dedupeKey: 'k1', type: 'issue_triage' }));
    const second = await enqueueJob(sql, job({ dedupeKey: 'k2', type: 'change_request_explain' }));

    const jobs = await listJobs(sql, { limit: 10 });
    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.id).toBe(second!.id);
    expect(jobs[1]?.id).toBe(first!.id);

    const total = await countJobs(sql);
    expect(total).toBe(2);

    const counts = await countJobsByStatus(sql);
    expect(counts['queued']).toBe(2);
  });

  it('filters jobs by status', async () => {
    const created = await enqueueJob(sql, job({ dedupeKey: 'k1' }));
    await claimJob(sql);

    const running = await listJobs(sql, { status: 'running' });
    expect(running).toHaveLength(1);
    expect(running[0]?.id).toBe(created!.id);

    const queued = await listJobs(sql, { status: 'queued' });
    expect(queued).toHaveLength(0);
  });
});

describe('getJobById', () => {
  it('returns a job by id or null when missing', async () => {
    const created = await enqueueJob(sql, job({ dedupeKey: 'k1' }));

    const found = await getJobById(sql, created!.id);
    expect(found).not.toBeNull();
    expect(found?.dedupeKey).toBe('k1');

    const missing = await getJobById(sql, '00000000-0000-0000-0000-000000000000');
    expect(missing).toBeNull();
  });
});

describe('cancelJob', () => {
  it('marks a job as dead with an admin cancellation message', async () => {
    const created = await enqueueJob(sql, job({ dedupeKey: 'k1' }));
    const cancelled = await cancelJob(sql, created!.id);

    expect(cancelled).not.toBeNull();
    expect(cancelled?.status).toBe('dead');
    expect(cancelled?.errorMessage).toBe('cancelled by admin');
    expect(cancelled?.finishedAt).not.toBeNull();
  });
});

describe('retryJob', () => {
  it('re-queues a dead job', async () => {
    const created = await enqueueJob(sql, job({ dedupeKey: 'k1' }));
    await killJob(sql, created!.id, 'boom');

    const retried = await retryJob(sql, created!.id);
    expect(retried).not.toBeNull();
    expect(retried?.status).toBe('queued');
    expect(retried?.attempts).toBe(0);
    expect(retried?.errorMessage).toBeNull();
    expect(retried?.startedAt).toBeNull();
    expect(retried?.finishedAt).toBeNull();
  });

  it('does nothing for a job that is not dead or failed', async () => {
    const created = await enqueueJob(sql, job({ dedupeKey: 'k1' }));

    const retried = await retryJob(sql, created!.id);
    expect(retried).toBeNull();

    const stillQueued = await getJobById(sql, created!.id);
    expect(stillQueued?.status).toBe('queued');
  });
});
