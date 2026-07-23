import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizePrivateKey, getInstallationOctokitForOrg, getInstallationOctokitForRepo, resetInstallationIdCache } from './auth.js';
import type { App } from '@octokit/app';

function createMockApp(installationIds: { orgs?: Record<string, number>; repos?: Record<string, number> } = {}): App {
  const requests: string[] = [];
  return {
    octokit: {
      request: async (route: string, params: Record<string, unknown>) => {
        requests.push(route);
        if (route === 'GET /orgs/{org}/installation') {
          const org = params.org as string;
          const id = installationIds.orgs?.[org];
          if (id === undefined) throw new Error(`Unexpected org: ${org}`);
          return { data: { id } };
        }
        if (route === 'GET /repos/{owner}/{repo}/installation') {
          const owner = params.owner as string;
          const repo = params.repo as string;
          const id = installationIds.repos?.[`${owner}/${repo}`];
          if (id === undefined) throw new Error(`Unexpected repo: ${owner}/${repo}`);
          return { data: { id } };
        }
        throw new Error(`Unexpected route: ${route}`);
      },
    },
    getInstallationOctokit: async (id: number) => ({ installationId: id } as unknown as App['getInstallationOctokit']),
    getRequests: () => requests,
  } as unknown as App;
}

describe('normalizePrivateKey', () => {
  it('returns a multi-line key unchanged', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nABCD\n-----END RSA PRIVATE KEY-----';
    expect(normalizePrivateKey(key)).toBe(key);
  });

  it('re-wraps a single-line PEM key into 64-character lines', () => {
    const body = 'A'.repeat(128);
    const key = `-----BEGIN RSA PRIVATE KEY-----${body}-----END RSA PRIVATE KEY-----`;
    const expected = `-----BEGIN RSA PRIVATE KEY-----\n${'A'.repeat(64)}\n${'A'.repeat(64)}\n-----END RSA PRIVATE KEY-----`;
    expect(normalizePrivateKey(key)).toBe(expected);
  });

  it('trims surrounding whitespace', () => {
    const key = '  -----BEGIN RSA PRIVATE KEY-----AB-----END RSA PRIVATE KEY-----  ';
    expect(normalizePrivateKey(key)).toBe('-----BEGIN RSA PRIVATE KEY-----\nAB\n-----END RSA PRIVATE KEY-----');
  });

  it('returns non-PEM strings unchanged', () => {
    expect(normalizePrivateKey('not a key')).toBe('not a key');
  });
});

describe('installation ID cache', () => {
  beforeEach(() => {
    resetInstallationIdCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('caches org installation IDs across calls', async () => {
    const mockApp = createMockApp({ orgs: { 'EPFL-ENAC': 123 } });

    await getInstallationOctokitForOrg(mockApp, 'EPFL-ENAC');
    await getInstallationOctokitForOrg(mockApp, 'EPFL-ENAC');

    expect((mockApp as unknown as { getRequests: () => string[] }).getRequests()).toEqual([
      'GET /orgs/{org}/installation',
    ]);
  });

  it('caches repo installation IDs across calls', async () => {
    const mockApp = createMockApp({ repos: { 'EPFL-ENAC/co2-calculator': 456 } });

    await getInstallationOctokitForRepo(mockApp, 'EPFL-ENAC/co2-calculator');
    await getInstallationOctokitForRepo(mockApp, 'EPFL-ENAC/co2-calculator');

    expect((mockApp as unknown as { getRequests: () => string[] }).getRequests()).toEqual([
      'GET /repos/{owner}/{repo}/installation',
    ]);
  });

  it('refetches after the cache entry expires', async () => {
    const mockApp = createMockApp({ orgs: { 'EPFL-ENAC': 123 } });

    await getInstallationOctokitForOrg(mockApp, 'EPFL-ENAC');
    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    await getInstallationOctokitForOrg(mockApp, 'EPFL-ENAC');

    expect((mockApp as unknown as { getRequests: () => string[] }).getRequests()).toEqual([
      'GET /orgs/{org}/installation',
      'GET /orgs/{org}/installation',
    ]);
  });

  it('does not share cache entries between orgs and repos', async () => {
    const mockApp = createMockApp({
      orgs: { 'EPFL-ENAC': 123 },
      repos: { 'EPFL-ENAC/co2-calculator': 456 },
    });

    await getInstallationOctokitForOrg(mockApp, 'EPFL-ENAC');
    await getInstallationOctokitForRepo(mockApp, 'EPFL-ENAC/co2-calculator');

    expect((mockApp as unknown as { getRequests: () => string[] }).getRequests()).toEqual([
      'GET /orgs/{org}/installation',
      'GET /repos/{owner}/{repo}/installation',
    ]);
  });
});
