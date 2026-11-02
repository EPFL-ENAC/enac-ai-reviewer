import type { InstallationOctokit } from './auth.js';

export interface CiCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
}

export interface CiFailedLog {
  /** Workflow job name, e.g. "build / test (node-22)". */
  jobName: string;
  failedStep: string | null;
  log: string;
}

export type CiState = 'passed' | 'failed' | 'pending' | 'none';

export interface CiContext {
  state: CiState;
  checkRuns: CiCheckRun[];
  failedLogs: CiFailedLog[];
}

const MAX_JOBS_PER_RUN = 20;
const MAX_LOG_CHARS = 30000;
const MAX_LOGS = 5;

const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);

function truncateTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `… (truncated)\n${text.slice(-maxChars)}`;
}

/** Aggregates CI state for a commit: check runs (apps) plus legacy commit statuses. */
export async function fetchCiContext(
  octokit: InstallationOctokit,
  target: { owner: string; repo: string; ref: string },
): Promise<CiContext> {
  const [checkRunsRes, statusRes] = await Promise.all([
    octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
      owner: target.owner,
      repo: target.repo,
      ref: target.ref,
      per_page: 100,
    }),
    octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/status', {
      owner: target.owner,
      repo: target.repo,
      ref: target.ref,
    }),
  ]);

  const checkRuns: CiCheckRun[] = checkRunsRes.data.check_runs.map((run) => ({
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    detailsUrl: run.details_url,
  }));

  const legacyStatuses = statusRes.data.statuses.map((s) => ({
    name: s.context,
    status: s.state === 'pending' ? 'in_progress' : 'completed',
    conclusion: s.state === 'pending' ? null : s.state,
  }));

  const allChecks = [...checkRuns, ...legacyStatuses];
  if (allChecks.length === 0) return { state: 'none', checkRuns: [], failedLogs: [] };

  const failed = allChecks.filter((c) => c.conclusion !== null && FAILED_CONCLUSIONS.has(c.conclusion));
  const running = allChecks.filter((c) => c.status === 'in_progress' || c.status === 'queued');

  let state: CiState;
  if (failed.length > 0) state = 'failed';
  else if (running.length > 0) state = 'pending';
  else state = 'passed';

  const failedLogs = state === 'failed' ? await fetchFailedActionLogs(octokit, target) : [];
  return { state, checkRuns, failedLogs };
}

/**
 * Fetches the logs of failed GitHub Actions jobs for a commit. Repos without Actions
 * (or runs we cannot see) yield an empty list instead of failing the job — the LLM
 * then diagnoses from the check-run names alone.
 */
async function fetchFailedActionLogs(
  octokit: InstallationOctokit,
  target: { owner: string; repo: string; ref: string },
): Promise<CiFailedLog[]> {
  let runs: { id: number; name: string }[];
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/runs', {
      owner: target.owner,
      repo: target.repo,
      head_sha: target.ref,
      per_page: 10,
    });
    runs = data.workflow_runs.filter((r) => r.conclusion === 'failure').map((r) => ({ id: r.id, name: r.name ?? `run-${r.id}` }));
  } catch (error) {
    if ((error as { status?: number }).status === 404) return [];
    throw error;
  }
  if (runs.length === 0) return [];

  const logs: CiFailedLog[] = [];
  for (const run of runs) {
    if (logs.length >= MAX_LOGS) break;
    const { data: jobsData } = await octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs', {
      owner: target.owner,
      repo: target.repo,
      run_id: run.id,
      per_page: MAX_JOBS_PER_RUN,
    });
    for (const job of jobsData.jobs) {
      if (logs.length >= MAX_LOGS) break;
      if (job.conclusion !== 'failure') continue;
      const failedStep = job.steps?.find((s) => s.conclusion === 'failure')?.name ?? null;
      let log = '';
      try {
        // Returns a 302 redirect to the log archive; octokit follows it and returns the text.
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs', {
          owner: target.owner,
          repo: target.repo,
          job_id: job.id,
        });
        log = typeof data === 'string' ? data : '';
      } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error;
      }
      logs.push({ jobName: job.name, failedStep, log: truncateTail(log, MAX_LOG_CHARS) });
    }
  }
  return logs;
}
