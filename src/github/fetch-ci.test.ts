import { describe, expect, it, vi } from 'vitest';
import { fetchCiContext } from './fetch-ci.js';
import type { InstallationOctokit } from './auth.js';

function octokit(responses: Record<string, unknown>) {
  return {
    request: vi.fn(async (route: string) => {
      const data = responses[route];
      if (data === undefined) throw new Error(`unexpected route ${route}`);
      return { data };
    }),
  };
}

function asOctokit(o: ReturnType<typeof octokit>): InstallationOctokit {
  return o as unknown as InstallationOctokit;
}

const CHECK_RUNS = 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs';
const STATUS = 'GET /repos/{owner}/{repo}/commits/{ref}/status';
const RUNS = 'GET /repos/{owner}/{repo}/actions/runs';
const JOBS = 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs';
const JOB_LOG = 'GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs';

describe('fetchCiContext', () => {
  it('returns passed with no logs when all check runs succeeded', async () => {
    const o = octokit({
      [CHECK_RUNS]: { check_runs: [{ name: 'build', status: 'completed', conclusion: 'success', details_url: 'u' }] },
      [STATUS]: { statuses: [] },
    });

    const ci = await fetchCiContext(asOctokit(o), { owner: 'o', repo: 'r', ref: 'abc' });

    expect(ci.state).toBe('passed');
    expect(ci.failedLogs).toEqual([]);
  });

  it('classifies legacy commit statuses alongside check runs', async () => {
    const o = octokit({
      [CHECK_RUNS]: { check_runs: [] },
      [STATUS]: { statuses: [{ context: 'jenkins/build', state: 'failure' }] },
      [RUNS]: { workflow_runs: [] },
    });

    const ci = await fetchCiContext(asOctokit(o), { owner: 'o', repo: 'r', ref: 'abc' });

    expect(ci.state).toBe('failed');
  });

  it('returns pending when nothing failed but a run is still in progress', async () => {
    const o = octokit({
      [CHECK_RUNS]: { check_runs: [{ name: 'build', status: 'in_progress', conclusion: null, details_url: null }] },
      [STATUS]: { statuses: [] },
    });

    const ci = await fetchCiContext(asOctokit(o), { owner: 'o', repo: 'r', ref: 'abc' });

    expect(ci.state).toBe('pending');
  });

  it('returns none when there are no checks at all', async () => {
    const o = octokit({ [CHECK_RUNS]: { check_runs: [] }, [STATUS]: { statuses: [] } });

    const ci = await fetchCiContext(asOctokit(o), { owner: 'o', repo: 'r', ref: 'abc' });

    expect(ci.state).toBe('none');
  });

  it('fetches the logs of failed Actions jobs when CI failed', async () => {
    const o = octokit({
      [CHECK_RUNS]: { check_runs: [{ name: 'build', status: 'completed', conclusion: 'failure', details_url: 'u' }] },
      [STATUS]: { statuses: [] },
      [RUNS]: { workflow_runs: [{ id: 1, name: 'CI', conclusion: 'failure' }, { id: 2, name: 'CI', conclusion: 'success' }] },
      [JOBS]: { jobs: [
        { id: 11, name: 'build / test', conclusion: 'failure', steps: [{ name: 'npm test', conclusion: 'failure' }] },
        { id: 12, name: 'build / lint', conclusion: 'success' },
      ] },
      [JOB_LOG]: '2026-11-02 line1\nError: expected 1 to equal 2',
    });

    const ci = await fetchCiContext(asOctokit(o), { owner: 'o', repo: 'r', ref: 'abc' });

    expect(ci.state).toBe('failed');
    expect(ci.failedLogs).toEqual([
      { jobName: 'build / test', failedStep: 'npm test', log: '2026-11-02 line1\nError: expected 1 to equal 2' },
    ]);
  });

  it('yields no logs when Actions is unavailable (404) instead of failing the job', async () => {
    const o = octokit({
      [CHECK_RUNS]: { check_runs: [{ name: 'circle/build', status: 'completed', conclusion: 'failure', details_url: 'u' }] },
      [STATUS]: { statuses: [] },
    });
    o.request = vi.fn(async (route: string) => {      if (route === RUNS) {
        const error = new Error('not found') as Error & { status?: number };
        error.status = 404;
        throw error;
      }
      if (route === CHECK_RUNS) return { data: { check_runs: [{ name: 'circle/build', status: 'completed', conclusion: 'failure', details_url: 'u' }] } };
      if (route === STATUS) return { data: { statuses: [] } };
      throw new Error(`unexpected route ${route}`);
    });

    const ci = await fetchCiContext(asOctokit(o), { owner: 'o', repo: 'r', ref: 'abc' });

    expect(ci.state).toBe('failed');
    expect(ci.failedLogs).toEqual([]);
  });

  it('keeps only the log tail when a log is very long', async () => {
    const longLog = `${'x'.repeat(40000)}\nError: the important line`;
    const o = octokit({
      [CHECK_RUNS]: { check_runs: [{ name: 'build', status: 'completed', conclusion: 'failure', details_url: 'u' }] },
      [STATUS]: { statuses: [] },
      [RUNS]: { workflow_runs: [{ id: 1, name: 'CI', conclusion: 'failure' }] },
      [JOBS]: { jobs: [{ id: 11, name: 'build / test', conclusion: 'failure', steps: [] }] },
      [JOB_LOG]: longLog,
    });

    const ci = await fetchCiContext(asOctokit(o), { owner: 'o', repo: 'r', ref: 'abc' });

    expect(ci.failedLogs[0]?.log.length).toBeLessThanOrEqual('… (truncated)\n'.length + 30000);
    expect(ci.failedLogs[0]?.log).toContain('Error: the important line');
  });
});
