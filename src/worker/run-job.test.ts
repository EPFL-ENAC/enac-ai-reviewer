import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewJob } from '../domain/types.js';

const getInstallationOctokitForRepo = vi.fn();
const postIssueComment = vi.fn();
const listIssueComments = vi.fn();
const updateIssueComment = vi.fn();
const fetchIssueContext = vi.fn();
const generateTriage = vi.fn();
const recordLlmUsage = vi.fn();

vi.mock('../github/auth.js', () => ({ getInstallationOctokitForRepo: (...args: unknown[]) => getInstallationOctokitForRepo(...args) }));
vi.mock('../github/publish.js', () => ({
  postIssueComment: (...args: unknown[]) => postIssueComment(...args),
  listIssueComments: (...args: unknown[]) => listIssueComments(...args),
  updateIssueComment: (...args: unknown[]) => updateIssueComment(...args),
}));
vi.mock('../github/fetch-context.js', () => ({ fetchIssueContext: (...args: unknown[]) => fetchIssueContext(...args) }));
vi.mock('../llm/triage.js', async () => {
  const actual = await vi.importActual<typeof import('../llm/triage.js')>('../llm/triage.js');
  return { ...actual, generateTriage: (...args: unknown[]) => generateTriage(...args) };
});
vi.mock('../db/jobs.js', () => ({ recordLlmUsage: (...args: unknown[]) => recordLlmUsage(...args) }));

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
  config: { GITHUB_BOT_LOGIN: 'enac-ai-reviewer', LLM_MODEL: 'test-model' } as never,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  llmModel: {} as never,
};

const triageResult = {
  likelyType: 'bug' as const,
  confidence: 'medium' as const,
  missingInformation: ['steps to reproduce'],
  suggestedLabels: ['bug'],
};

beforeEach(() => {
  vi.clearAllMocks();
  getInstallationOctokitForRepo.mockResolvedValue({ fake: 'octokit' });
  fetchIssueContext.mockResolvedValue({ title: 't', body: 'b', labels: [], comments: [] });
  generateTriage.mockResolvedValue({ result: triageResult, inputTokens: 100, outputTokens: 50 });
  listIssueComments.mockResolvedValue([]);
});

describe('runJob issue_triage', () => {
  it('posts a new triage comment when none exists yet', async () => {
    await runJob(ctx, job());

    expect(postIssueComment).toHaveBeenCalledWith(
      { fake: 'octokit' },
      expect.objectContaining({ owner: 'EPFL-ENAC', repo: 'co2-calculator', issueNumber: 42 }),
    );
    expect(updateIssueComment).not.toHaveBeenCalled();
    expect(recordLlmUsage).toHaveBeenCalledWith(
      ctx.sql,
      expect.objectContaining({ jobId: 'job-1', model: 'test-model', inputTokens: 100, outputTokens: 50 }),
    );
  });

  it('updates the existing bot triage comment instead of posting a new one', async () => {
    listIssueComments.mockResolvedValue([
      { id: 555, body: '### AI triage\n\nold content', user: { login: 'enac-ai-reviewer' } },
      { id: 556, body: 'unrelated human comment', user: { login: 'guilbep' } },
    ]);

    await runJob(ctx, job());

    expect(updateIssueComment).toHaveBeenCalledWith(
      { fake: 'octokit' },
      expect.objectContaining({ commentId: 555 }),
    );
    expect(postIssueComment).not.toHaveBeenCalled();
  });

  it('ignores bot comments that are not triage comments when looking for a prior one', async () => {
    listIssueComments.mockResolvedValue([{ id: 555, body: 'some other bot comment', user: { login: 'enac-ai-reviewer' } }]);

    await runJob(ctx, job());

    expect(postIssueComment).toHaveBeenCalled();
    expect(updateIssueComment).not.toHaveBeenCalled();
  });

  it('throws for a job type without a handler yet', async () => {
    await expect(runJob(ctx, job({ type: 'change_request_review' }))).rejects.toThrow(/no handler/i);
  });

  it('throws if an issue_triage job is missing its issue number', async () => {
    await expect(runJob(ctx, job({ issueNumber: null }))).rejects.toThrow(/issueNumber/);
  });
});
