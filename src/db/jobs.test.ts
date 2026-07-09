import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, type Sql } from './pool.js';
import { claimJob, completeJob, enqueueJob, failJob, insertDelivery, killJob } from './jobs.js';
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
  await sql`truncate llm_usage, review_jobs, webhook_deliveries`;
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
