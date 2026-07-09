import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewJob } from '../domain/types.js';

const getInstallationOctokitForRepo = vi.fn();
const postIssueComment = vi.fn();
const listIssueComments = vi.fn();
const updateIssueComment = vi.fn();
const listReviewComments = vi.fn();
const createPullRequestReview = vi.fn();
const fetchIssueContext = vi.fn();
const fetchChangeRequestContext = vi.fn();
const generateTriage = vi.fn();
const generateExplain = vi.fn();
const generateReview = vi.fn();
const recordLlmUsage = vi.fn();

vi.mock('../github/auth.js', () => ({ getInstallationOctokitForRepo: (...args: unknown[]) => getInstallationOctokitForRepo(...args) }));
vi.mock('../github/publish.js', () => ({
  postIssueComment: (...args: unknown[]) => postIssueComment(...args),
  listIssueComments: (...args: unknown[]) => listIssueComments(...args),
  updateIssueComment: (...args: unknown[]) => updateIssueComment(...args),
  listReviewComments: (...args: unknown[]) => listReviewComments(...args),
  createPullRequestReview: (...args: unknown[]) => createPullRequestReview(...args),
}));
vi.mock('../github/fetch-context.js', () => ({
  fetchIssueContext: (...args: unknown[]) => fetchIssueContext(...args),
  fetchChangeRequestContext: (...args: unknown[]) => fetchChangeRequestContext(...args),
}));
vi.mock('../llm/triage.js', async () => {
  const actual = await vi.importActual<typeof import('../llm/triage.js')>('../llm/triage.js');
  return { ...actual, generateTriage: (...args: unknown[]) => generateTriage(...args) };
});
vi.mock('../llm/explain.js', async () => {
  const actual = await vi.importActual<typeof import('../llm/explain.js')>('../llm/explain.js');
  return { ...actual, generateExplain: (...args: unknown[]) => generateExplain(...args) };
});
vi.mock('../llm/review.js', async () => {
  const actual = await vi.importActual<typeof import('../llm/review.js')>('../llm/review.js');
  return { ...actual, generateReview: (...args: unknown[]) => generateReview(...args) };
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
    await expect(runJob(ctx, job({ type: 'review_thread_reply' }))).rejects.toThrow(/no handler/i);
  });

  it('throws if an issue_triage job is missing its issue number', async () => {
    await expect(runJob(ctx, job({ issueNumber: null }))).rejects.toThrow(/issueNumber/);
  });
});

describe('runJob change_request_explain', () => {
  const explainResult = { summary: 'Adds a widget.', keyChanges: ['Added Widget component'] };
  const explainJob = () =>
    job({ type: 'change_request_explain', issueNumber: null, changeRequestNumber: 7 });

  beforeEach(() => {
    fetchChangeRequestContext.mockResolvedValue({ title: 't', body: 'b', headSha: 'abc123', diff: 'diff --git a/x b/x' });
    generateExplain.mockResolvedValue({ result: explainResult, inputTokens: 200, outputTokens: 80 });
  });

  it('posts a new summary comment when none exists yet', async () => {
    await runJob(ctx, explainJob());

    expect(fetchChangeRequestContext).toHaveBeenCalledWith({ fake: 'octokit' }, { owner: 'EPFL-ENAC', repo: 'co2-calculator', number: 7 });
    expect(postIssueComment).toHaveBeenCalledWith(
      { fake: 'octokit' },
      expect.objectContaining({ owner: 'EPFL-ENAC', repo: 'co2-calculator', issueNumber: 7 }),
    );
    expect(recordLlmUsage).toHaveBeenCalledWith(
      ctx.sql,
      expect.objectContaining({ jobId: 'job-1', inputTokens: 200, outputTokens: 80 }),
    );
  });

  it('updates its own prior summary comment instead of posting a new one', async () => {
    listIssueComments.mockResolvedValue([{ id: 900, body: '### AI summary\n\nold', user: { login: 'enac-ai-reviewer' } }]);

    await runJob(ctx, explainJob());

    expect(updateIssueComment).toHaveBeenCalledWith({ fake: 'octokit' }, expect.objectContaining({ commentId: 900 }));
    expect(postIssueComment).not.toHaveBeenCalled();
  });

  it('throws if a change_request_explain job is missing its change request number', async () => {
    await expect(runJob(ctx, job({ type: 'change_request_explain', changeRequestNumber: null }))).rejects.toThrow(
      /changeRequestNumber/,
    );
  });
});

describe('runJob change_request_review', () => {
  const DIFF = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +1,3 @@
 ctx
-old
+new
+another new line
`;
  const reviewJob = () => job({ type: 'change_request_review', issueNumber: null, changeRequestNumber: 7 });

  beforeEach(() => {
    fetchChangeRequestContext.mockResolvedValue({ title: 't', body: 'b', headSha: 'abc123', diff: DIFF });
    listReviewComments.mockResolvedValue([]);
  });

  it('posts one review with only findings that land on real diff anchors, above the confidence floor', async () => {
    generateReview.mockResolvedValue({
      result: {
        summary: 'Looks mostly fine.',
        findings: [
          { path: 'src/foo.ts', line: 2, side: 'RIGHT', confidence: 'high', body: 'valid anchor, high confidence' },
          { path: 'src/foo.ts', line: 2, side: 'RIGHT', confidence: 'low', body: 'valid anchor, but low confidence' },
          { path: 'src/foo.ts', line: 999, side: 'RIGHT', confidence: 'high', body: 'invented line, not in the diff' },
        ],
      },
      inputTokens: 300,
      outputTokens: 120,
    });

    await runJob(ctx, reviewJob());

    expect(createPullRequestReview).toHaveBeenCalledWith(
      { fake: 'octokit' },
      expect.objectContaining({
        owner: 'EPFL-ENAC',
        repo: 'co2-calculator',
        pullNumber: 7,
        body: 'Looks mostly fine.',
        comments: [{ path: 'src/foo.ts', line: 2, side: 'RIGHT', body: 'valid anchor, high confidence' }],
      }),
    );
  });

  it('skips a finding that duplicates an existing review comment', async () => {
    listReviewComments.mockResolvedValue([{ path: 'src/foo.ts', line: 2, side: 'RIGHT' }]);
    generateReview.mockResolvedValue({
      result: {
        summary: 'ok',
        findings: [{ path: 'src/foo.ts', line: 2, side: 'RIGHT', confidence: 'high', body: 'dup' }],
      },
      inputTokens: 10,
      outputTokens: 5,
    });

    await runJob(ctx, reviewJob());

    expect(createPullRequestReview).toHaveBeenCalledWith({ fake: 'octokit' }, expect.objectContaining({ comments: [] }));
  });

  it('posts a summary-only review when there are no surviving findings', async () => {
    generateReview.mockResolvedValue({ result: { summary: 'Nothing to flag.', findings: [] }, inputTokens: 10, outputTokens: 5 });

    await runJob(ctx, reviewJob());

    expect(createPullRequestReview).toHaveBeenCalledWith(
      { fake: 'octokit' },
      expect.objectContaining({ body: 'Nothing to flag.', comments: [] }),
    );
  });

  it('never sets an APPROVE or REQUEST_CHANGES event', async () => {
    generateReview.mockResolvedValue({ result: { summary: 's', findings: [] }, inputTokens: 1, outputTokens: 1 });

    await runJob(ctx, reviewJob());

    const call = createPullRequestReview.mock.calls[0]?.[1] as { event?: string } | undefined;
    expect(call?.event).toBeUndefined(); // createPullRequestReview itself hardcodes COMMENT, not passed by the caller
  });

  it('throws if a change_request_review job is missing its change request number', async () => {
    await expect(runJob(ctx, job({ type: 'change_request_review', changeRequestNumber: null }))).rejects.toThrow(
      /changeRequestNumber/,
    );
  });
});
