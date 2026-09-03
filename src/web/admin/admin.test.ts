import type { App } from '@octokit/app';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createPool, type Sql } from '../../db/pool.js';
import type { WebConfig } from '../../domain/config.js';
import { buildApp } from '../app.js';
import { enqueueJob, getJobById, getJobTraces, insertJobTrace, killJob } from '../../db/jobs.js';
import type { NewReviewJob } from '../../domain/types.js';
import type { AdminUser } from './auth.js';
import type { KeycloakAuth } from './keycloak.js';

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
  ADMIN_AUTH_MODE: 'proxy',
  ADMIN_AUTH_HEADER_USER: 'X-Auth-Request-User',
  ADMIN_AUTH_HEADER_EMAIL: 'X-Auth-Request-Email',
  ADMIN_AUTH_USERS: '',
  TRUST_PROXY: false,
  adminAuthUsers: [],
  COOKIE_SECURE: false,
};

const mockGithubApp = { octokit: {} } as unknown as App;

const sql: Sql = createPool(databaseUrl);
let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp(sql, config, mockGithubApp);
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

  it('returns 403 when the user is not in the allowlist', async () => {
    const restrictedConfig: WebConfig = { ...config, adminAuthUsers: ['only-admin'] };
    const restrictedApp = await buildApp(sql, restrictedConfig, mockGithubApp);
    const res = await restrictedApp.inject({
      method: 'GET',
      url: '/admin',
      headers: authHeaders('other-user'),
    });
    expect(res.statusCode).toBe(403);
    expect(res.payload).toContain('Access denied');
  });

  it('allows access without a header when admin auth is disabled', async () => {
    const disabledConfig: WebConfig = { ...config, ADMIN_AUTH_ENABLED: false };
    const disabledApp = await buildApp(sql, disabledConfig, mockGithubApp);
    const res = await disabledApp.inject({ method: 'GET', url: '/admin/jobs' });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('Admin — Jobs');
  });
});

function createMockKeycloakAuth(): KeycloakAuth {
  return {
    getLoginUrl: vi.fn((_request, redirectTo = '/admin') => `https://keycloak.example.com/login?redirect=${encodeURIComponent(redirectTo)}`),
    handleCallback: vi.fn(async (request) => {
      const user: AdminUser = { user: 'keycloak-user', email: 'keycloak@example.com' };
      request.session.set('adminUser', user);
      return { user, redirectTo: '/admin' };
    }),
    getUser: (request) => request.session.get('adminUser') ?? null,
    getLogoutUrl: vi.fn((request) => {
      request.session.delete();
      return '/admin';
    }),
  };
}

function keycloakConfig(overrides: Partial<WebConfig> = {}): WebConfig {
  return {
    ...config,
    ADMIN_AUTH_MODE: 'keycloak',
    KEYCLOAK_URL: 'https://keycloak.example.com',
    KEYCLOAK_REALM: 'test-realm',
    KEYCLOAK_CLIENT_ID: 'test-client',
    KEYCLOAK_CLIENT_SECRET: 'test-secret',
    KEYCLOAK_REDIRECT_URI: 'https://app.example.com/admin/auth/callback',
    SESSION_SECRET: 'a-very-long-session-secret-for-tests-32b',
    ...overrides,
  };
}

describe('Admin UI Keycloak authentication', () => {
  it('redirects unauthenticated HTML requests to the Keycloak login URL', async () => {
    const mockAuth = createMockKeycloakAuth();
    const kcApp = await buildApp(sql, keycloakConfig(), mockGithubApp, mockAuth);

    const res = await kcApp.inject({ method: 'GET', url: '/admin' });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('https://keycloak.example.com/login');
  });

  it('redirects the login route to the Keycloak authorization endpoint', async () => {
    const mockAuth = createMockKeycloakAuth();
    const kcApp = await buildApp(sql, keycloakConfig(), mockGithubApp, mockAuth);

    const res = await kcApp.inject({ method: 'GET', url: '/admin/login' });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://keycloak.example.com/login?redirect=%2Fadmin');
  });

  it('handles the OIDC callback and protects subsequent requests', async () => {
    const mockAuth = createMockKeycloakAuth();
    const kcApp = await buildApp(sql, keycloakConfig(), mockGithubApp, mockAuth);

    const callbackRes = await kcApp.inject({ method: 'GET', url: '/admin/auth/callback?code=abc&state=xyz' });
    expect(callbackRes.statusCode).toBe(302);
    expect(callbackRes.headers.location).toBe('/admin');

    const cookies = callbackRes.cookies;
    expect(cookies).toBeDefined();
    expect(cookies.length).toBeGreaterThan(0);

    const sessionCookie = cookies.find((c) => c.name === 'session');
    expect(sessionCookie).toBeDefined();

    const jobsRes = await kcApp.inject({
      method: 'GET',
      url: '/admin/jobs',
      cookies: { session: sessionCookie!.value },
    });
    expect(jobsRes.statusCode).toBe(200);
    expect(jobsRes.payload).toContain('keycloak-user');
  });

  it('returns 401 for the JSON API when the Keycloak session is missing', async () => {
    const mockAuth = createMockKeycloakAuth();
    const kcApp = await buildApp(sql, keycloakConfig(), mockGithubApp, mockAuth);

    const res = await kcApp.inject({ method: 'GET', url: '/admin/api/jobs' });

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.payload)).toEqual({ error: 'Authentication required' });
  });

  it('clears the session on logout', async () => {
    const mockAuth = createMockKeycloakAuth();
    const kcApp = await buildApp(sql, keycloakConfig(), mockGithubApp, mockAuth);

    const callbackRes = await kcApp.inject({ method: 'GET', url: '/admin/auth/callback?code=abc&state=xyz' });
    const sessionCookie = callbackRes.cookies.find((c) => c.name === 'session');
    expect(sessionCookie).toBeDefined();

    const logoutRes = await kcApp.inject({
      method: 'GET',
      url: '/admin/logout',
      cookies: { session: sessionCookie!.value },
    });
    expect(logoutRes.statusCode).toBe(302);
    expect(logoutRes.headers.location).toBe('/admin');

    const clearedCookie = logoutRes.cookies.find((c) => c.name === 'session');
    expect(clearedCookie).toBeDefined();
    expect(clearedCookie!.value).toBe('');

    const jobsRes = await kcApp.inject({
      method: 'GET',
      url: '/admin/jobs',
      cookies: { session: clearedCookie!.value },
    });
    expect(jobsRes.statusCode).toBe(302);
    expect(jobsRes.headers.location).toContain('https://keycloak.example.com/login');
  });

  it('respects the allowlist in Keycloak mode', async () => {
    const mockAuth = createMockKeycloakAuth();
    const kcApp = await buildApp(sql, keycloakConfig({ adminAuthUsers: ['only-admin'] }), mockGithubApp, mockAuth);

    const callbackRes = await kcApp.inject({ method: 'GET', url: '/admin/auth/callback?code=abc&state=xyz' });
    const sessionCookie = callbackRes.cookies.find((c) => c.name === 'session');

    const jobsRes = await kcApp.inject({
      method: 'GET',
      url: '/admin/jobs',
      cookies: { session: sessionCookie!.value },
    });
    expect(jobsRes.statusCode).toBe(403);
    expect(jobsRes.payload).toContain('Access denied');
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

describe('Admin UI job actions', () => {
  it('cancels a queued job and records an admin trace', async () => {
    const created = await enqueueJob(sql, baseJob());

    const res = await app.inject({
      method: 'POST',
      url: `/admin/jobs/${created!.id}/cancel`,
      headers: { ...authHeaders(), 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'submit=Cancel',
    });
    expect(res.statusCode).toBe(302);

    const updated = await getJobById(sql, created!.id);
    expect(updated?.status).toBe('dead');
    expect(updated?.errorMessage).toBe('cancelled by admin');

    const traces = await getJobTraces(sql, created!.id);
    expect(traces.some((t) => t.type === 'admin_cancel')).toBe(true);
  });

  it('retries a dead job and records an admin trace', async () => {
    const created = await enqueueJob(sql, baseJob());
    await killJob(sql, created!.id, 'boom');

    const res = await app.inject({
      method: 'POST',
      url: `/admin/jobs/${created!.id}/retry`,
      headers: { ...authHeaders(), 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'submit=Retry',
    });
    expect(res.statusCode).toBe(302);

    const updated = await getJobById(sql, created!.id);
    expect(updated?.status).toBe('queued');

    const traces = await getJobTraces(sql, created!.id);
    expect(traces.some((t) => t.type === 'admin_retry')).toBe(true);
  });

  it('rejects action requests without auth', async () => {
    const created = await enqueueJob(sql, baseJob());

    const cancelRes = await app.inject({
      method: 'POST',
      url: `/admin/jobs/${created!.id}/cancel`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'submit=Cancel',
    });
    expect(cancelRes.statusCode).toBe(401);
  });
});
