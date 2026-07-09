import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewJob } from '../domain/types.js';

const getInstallationOctokitForRepo = vi.fn();
const postIssueComment = vi.fn();

vi.mock('../github/auth.js', () => ({ getInstallationOctokitForRepo: (...args: unknown[]) => getInstallationOctokitForRepo(...args) }));
vi.mock('../github/publish.js', () => ({ postIssueComment: (...args: unknown[]) => postIssueComment(...args) }));

const { runJob } = await import('./run-job.js');

function job(overrides: Partial<ReviewJob> = {}): ReviewJob {
  return {
    id: 'job-1',
    provider: 'github',
    type: 'issue_triage',
    status: 'running',
    repositoryFullName: 'EPFL-ENAC/co2-calculator',
    issueNumber: 42,
    changeRequestNumber: null,
    headSha: null,
    triggerActor: 'guilbep',
    dedupeKey: 'k1',
    payload: {},
    attempts: 1,
    maxAttempts: 3,
    createdAt: new Date(),
    startedAt: new Date(),
    finishedAt: null,
    errorMessage: null,
    ...overrides,
  };
}

const ctx = {
  sql: {} as never,
  githubApp: {} as never,
  config: {} as never,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
};

beforeEach(() => {
  vi.clearAllMocks();
  getInstallationOctokitForRepo.mockResolvedValue({ fake: 'octokit' });
});

describe('runJob', () => {
  it('posts a triage comment for issue_triage jobs', async () => {
    await runJob(ctx, job());

    expect(getInstallationOctokitForRepo).toHaveBeenCalledWith(ctx.githubApp, 'EPFL-ENAC/co2-calculator');
    expect(postIssueComment).toHaveBeenCalledWith(
      { fake: 'octokit' },
      expect.objectContaining({ owner: 'EPFL-ENAC', repo: 'co2-calculator', issueNumber: 42 }),
    );
  });

  it('throws for a job type without a handler yet', async () => {
    await expect(runJob(ctx, job({ type: 'change_request_review' }))).rejects.toThrow(/no handler/i);
  });

  it('throws if an issue_triage job is missing its issue number', async () => {
    await expect(runJob(ctx, job({ issueNumber: null }))).rejects.toThrow(/issueNumber/);
  });
});
