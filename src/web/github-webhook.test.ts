import { createHmac } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createPool, type Sql } from '../db/pool.js';
import type { WebConfig } from '../domain/config.js';
import { buildApp } from './app.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL must be set to run webhook tests (see docker-compose.yml)');
}

const WEBHOOK_SECRET = 'test-secret';

const config: WebConfig = {
  GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
  DATABASE_URL: databaseUrl,
  ALLOWED_REPOSITORIES: 'EPFL-ENAC/co2-calculator',
  GITHUB_BOT_LOGIN: 'enac-ai-reviewer',
  PORT: 3000,
  allowedRepositories: ['EPFL-ENAC/co2-calculator'],
};

const sql: Sql = createPool(databaseUrl);
let app: FastifyInstance;

function sign(body: string): string {
  return `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;
}

async function postWebhook(opts: { event: string; deliveryId: string; payload: unknown; badSignature?: boolean }) {
  const body = JSON.stringify(opts.payload);
  const signature = opts.badSignature ? 'sha256=deadbeef' : sign(body);
  return app.inject({
    method: 'POST',
    url: '/webhooks/github',
    headers: {
      'content-type': 'application/json',
      'x-github-event': opts.event,
      'x-github-delivery': opts.deliveryId,
      'x-hub-signature-256': signature,
    },
    payload: body,
  });
}

function issueCommentPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'created',
    comment: { id: 1, body: '@enac-ai-reviewer triage', user: { login: 'guilbep' } },
    issue: { number: 42 },
    repository: { full_name: 'EPFL-ENAC/co2-calculator' },
    ...overrides,
  };
}

beforeEach(async () => {
  app = buildApp(sql, config);
  await sql`truncate llm_usage, review_jobs, webhook_deliveries`;
});

afterAll(async () => {
  await sql.end();
});

describe('POST /webhooks/github', () => {
  it('rejects an invalid signature with 401', async () => {
    const res = await postWebhook({ event: 'issue_comment', deliveryId: 'd1', payload: issueCommentPayload(), badSignature: true });
    expect(res.statusCode).toBe(401);

    const rows = await sql`select count(*)::int as count from review_jobs`;
    expect(rows[0]?.count).toBe(0);
  });

  it('creates one queued job for a valid triage mention', async () => {
    const res = await postWebhook({ event: 'issue_comment', deliveryId: 'd1', payload: issueCommentPayload() });
    expect(res.statusCode).toBe(202);

    const rows = await sql`select type, status, issue_number from review_jobs`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('issue_triage');
    expect(rows[0]?.status).toBe('queued');
    expect(rows[0]?.issue_number).toBe(42);
  });

  it('does not create a duplicate job for a redelivered delivery id', async () => {
    await postWebhook({ event: 'issue_comment', deliveryId: 'd1', payload: issueCommentPayload() });
    const second = await postWebhook({ event: 'issue_comment', deliveryId: 'd1', payload: issueCommentPayload() });
    expect(second.statusCode).toBe(200);

    const rows = await sql`select count(*)::int as count from review_jobs`;
    expect(rows[0]?.count).toBe(1);
  });

  it('ignores a repository outside the allowlist', async () => {
    const res = await postWebhook({
      event: 'issue_comment',
      deliveryId: 'd1',
      payload: issueCommentPayload({ repository: { full_name: 'someone-else/other-repo' } }),
    });
    expect(res.statusCode).toBe(204);

    const rows = await sql`select count(*)::int as count from review_jobs`;
    expect(rows[0]?.count).toBe(0);
  });

  it('ignores comments authored by the bot itself', async () => {
    const res = await postWebhook({
      event: 'issue_comment',
      deliveryId: 'd1',
      payload: issueCommentPayload({ comment: { id: 1, body: '@enac-ai-reviewer triage', user: { login: 'enac-ai-reviewer' } } }),
    });
    expect(res.statusCode).toBe(204);

    const rows = await sql`select count(*)::int as count from review_jobs`;
    expect(rows[0]?.count).toBe(0);
  });

  it('ignores a comment with no recognized command', async () => {
    const res = await postWebhook({
      event: 'issue_comment',
      deliveryId: 'd1',
      payload: issueCommentPayload({ comment: { id: 1, body: 'just chatting', user: { login: 'guilbep' } } }),
    });
    expect(res.statusCode).toBe(204);
  });

  it('creates a change_request_review job for an ai-review label on a PR, keyed by head sha', async () => {
    const payload = {
      action: 'labeled',
      label: { name: 'ai-review' },
      repository: { full_name: 'EPFL-ENAC/co2-calculator' },
      pull_request: { number: 7, head: { sha: 'abc123' } },
    };
    const res = await postWebhook({ event: 'pull_request', deliveryId: 'd1', payload });
    expect(res.statusCode).toBe(202);

    const rows = await sql`select type, change_request_number, head_sha, dedupe_key from review_jobs`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('change_request_review');
    expect(rows[0]?.change_request_number).toBe(7);
    expect(rows[0]?.head_sha).toBe('abc123');
  });

  it('does not enqueue a second review job for the same PR head sha across two different deliveries', async () => {
    const payload = {
      action: 'labeled',
      label: { name: 'ai-review' },
      repository: { full_name: 'EPFL-ENAC/co2-calculator' },
      pull_request: { number: 7, head: { sha: 'abc123' } },
    };
    await postWebhook({ event: 'pull_request', deliveryId: 'd1', payload });
    // Simulates the label being removed and re-applied (or a second reviewer
    // re-triggering) while the head sha is unchanged — same dedupe_key, no new job.
    const second = await postWebhook({ event: 'pull_request', deliveryId: 'd2', payload });
    expect(second.statusCode).toBe(202);

    const rows = await sql`select count(*)::int as count from review_jobs where change_request_number = 7`;
    expect(rows[0]?.count).toBe(1);
  });

  it('responds fast without waiting on any LLM call (202 with no job-processing delay)', async () => {
    const start = Date.now();
    const res = await postWebhook({ event: 'issue_comment', deliveryId: 'd1', payload: issueCommentPayload() });
    expect(res.statusCode).toBe(202);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
