import type { App } from '@octokit/app';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createPool, type Sql } from '../../db/pool.js';
import type { WebConfig } from '../../domain/config.js';
import { buildApp } from '../app.js';
import { enqueueJob, insertJobTrace } from '../../db/jobs.js';
import type { NewReviewJob } from '../../domain/types.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL must be set to run admin tests (see docker-compose.yml)');
}

function baseJob(overrides: Partial<NewReviewJob> = {}): NewReviewJob {
  return {
    provider: 'github',
    type: 'issue_triage',
    repositoryFullName: 'EPFL-ENAC/co2-calculator',
    issueNumber: 42,
    triggerActor: 'guilbep',
    dedupeKey: `github:EPFL-ENAC/co2-calculator:issue_triage:42:${Math.random()}`,
    payload: { foo: 'bar' },
    ...overrides,
  };
}

const config: WebConfig = {
  GITHUB_WEBHOOK_SECRET: 'test-secret',
  DATABASE_URL: databaseUrl,
  ALLOWED_ORGANIZATIONS: 'EPFL-ENAC',
  GITHUB_BOT_LOGIN: 'enac-ai-reviewer',
  GITHUB_APP_ID: '123',
  GITHUB_PRIVATE_KEY: 'dummy',
  PORT: 3000,
  allowedOrganizations: ['EPFL-ENAC'],
  ADMIN_AUTH_ENABLED: true,
  ADMIN_AUTH_HEADER_USER: 'X-Auth-Request-User',
  ADMIN_AUTH_HEADER_EMAIL: 'X-Auth-Request-Email',
  ADMIN_AUTH_USERS: '',
  TRUST_PROXY: false,
  adminAuthUsers: [],
};

const mockGithubApp = { octokit: {} } as unknown as App;

const sql: Sql = createPool(databaseUrl);
let app: FastifyInstance;

beforeEach(async () => {
  app = buildApp(sql, config, mockGithubApp);
  await sql`truncate job_traces, llm_usage, review_jobs, webhook_deliveries`;
});

afterAll(async () => {
  await sql.end();
});

function authHeaders(user = 'admin-user'): Record<string, string> {
  return {
    'x-auth-request-user': user,
    'x-auth-request-email': `${user}@example.com`,
  };
}

describe('Admin UI authentication', () => {
  it('returns 401 when the auth header is missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('returns 401 for the JSON API when the auth header is missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/api/jobs' });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.payload)).toEqual({ error: 'Authentication required' });
  });

  it('returns 401 when the user is not in the allowlist', async () => {
    const restrictedConfig: WebConfig = { ...config, adminAuthUsers: ['only-admin'] };
    const restrictedApp = buildApp(sql, restrictedConfig, mockGithubApp);
    const res = await restrictedApp.inject({
      method: 'GET',
      url: '/admin',
      headers: authHeaders('other-user'),
    });
    expect(res.statusCode).toBe(401);
  });

  it('allows access without a header when admin auth is disabled', async () => {
    const disabledConfig: WebConfig = { ...config, ADMIN_AUTH_ENABLED: false };
    const disabledApp = buildApp(sql, disabledConfig, mockGithubApp);
    const res = await disabledApp.inject({ method: 'GET', url: '/admin/jobs' });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('Admin — Jobs');
  });
});

describe('Admin UI job list', () => {
  it('renders the HTML job list', async () => {
    await enqueueJob(sql, baseJob());

    const res = await app.inject({ method: 'GET', url: '/admin/jobs', headers: authHeaders() });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.payload).toContain('Admin — Jobs');
    expect(res.payload).toContain('issue_triage');
  });

  it('returns the JSON job list', async () => {
    const created = await enqueueJob(sql, baseJob());

    const res = await app.inject({ method: 'GET', url: '/admin/api/jobs', headers: authHeaders() });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0]?.id).toBe(created!.id);
    expect(body.counts['queued']).toBe(1);
  });
});

describe('Admin UI job detail', () => {
  it('renders the job detail with its trace', async () => {
    const created = await enqueueJob(sql, baseJob());
    await insertJobTrace(sql, { jobId: created!.id, type: 'llm_prompt', payload: { prompt: 'hello' } });

    const res = await app.inject({
      method: 'GET',
      url: `/admin/jobs/${created!.id}`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain(created!.id);
    expect(res.payload).toContain('llm_prompt');
    expect(res.payload).toContain('hello');
  });

  it('returns 404 for an unknown job', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/jobs/00000000-0000-0000-0000-000000000000',
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns the JSON job detail', async () => {
    const created = await enqueueJob(sql, baseJob());
    await insertJobTrace(sql, { jobId: created!.id, type: 'job_started' });

    const res = await app.inject({
      method: 'GET',
      url: `/admin/api/jobs/${created!.id}`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.job.id).toBe(created!.id);
    expect(body.traces).toHaveLength(1);
  });
});
