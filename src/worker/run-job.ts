import type { App } from '@octokit/app';
import type { Logger } from 'pino';
import { recordLlmUsage } from '../db/jobs.js';
import type { Sql } from '../db/pool.js';
import type { WorkerConfig } from '../domain/config.js';
import type { ReviewJob } from '../domain/types.js';
import { getInstallationOctokitForRepo, type InstallationOctokit } from '../github/auth.js';
import { parseDiffAnchors } from '../github/diff-anchors.js';
import { fetchChangeRequestContext, fetchIssueContext } from '../github/fetch-context.js';
import {
  createPullRequestReview,
  listIssueComments,
  listReviewComments,
  postIssueComment,
  updateIssueComment,
} from '../github/publish.js';
import type { LlmModel } from '../llm/client.js';
import { formatExplainComment, generateExplain } from '../llm/explain.js';
import { generateReview } from '../llm/review.js';
import { formatTriageComment, generateTriage } from '../llm/triage.js';
import { selectReviewFindings } from './select-review-findings.js';

export interface WorkerContext {
  sql: Sql;
  githubApp: App;
  config: WorkerConfig;
  logger: Logger;
  llmModel: LlmModel;
}

const TRIAGE_COMMENT_MARKER = '### AI triage';
const EXPLAIN_COMMENT_MARKER = '### AI summary';

/** Anti-spam: update our own prior comment carrying this marker instead of posting a new one every re-trigger. */
async function postOrUpdateMarkedComment(
  ctx: WorkerContext,
  octokit: InstallationOctokit,
  target: { owner: string; repo: string; issueNumber: number },
  marker: string,
  body: string,
): Promise<void> {
  const existingComments = await listIssueComments(octokit, target);
  const priorComment = existingComments.find(
    (c) => c.user?.login === ctx.config.GITHUB_BOT_LOGIN && c.body?.startsWith(marker),
  );

  if (priorComment) {
    await updateIssueComment(octokit, { owner: target.owner, repo: target.repo, commentId: priorComment.id, body });
  } else {
    await postIssueComment(octokit, { ...target, body });
  }
}

async function runIssueTriage(ctx: WorkerContext, job: ReviewJob, owner: string, repo: string): Promise<void> {
  if (job.issueNumber == null) throw new Error('issue_triage job missing issueNumber');

  const octokit = await getInstallationOctokitForRepo(ctx.githubApp, job.repositoryFullName);
  const target = { owner, repo, issueNumber: job.issueNumber };

  const context = await fetchIssueContext(octokit, target);
  const outcome = await generateTriage(ctx.llmModel, {
    title: context.title,
    body: context.body,
    existingLabels: context.labels,
    comments: context.comments,
  });

  await postOrUpdateMarkedComment(ctx, octokit, target, TRIAGE_COMMENT_MARKER, formatTriageComment(outcome.result));

  await recordLlmUsage(ctx.sql, {
    jobId: job.id,
    model: ctx.config.LLM_MODEL,
    inputTokens: outcome.inputTokens,
    outputTokens: outcome.outputTokens,
  });
}

async function runChangeRequestExplain(ctx: WorkerContext, job: ReviewJob, owner: string, repo: string): Promise<void> {
  if (job.changeRequestNumber == null) throw new Error('change_request_explain job missing changeRequestNumber');

  const octokit = await getInstallationOctokitForRepo(ctx.githubApp, job.repositoryFullName);
  const target = { owner, repo, issueNumber: job.changeRequestNumber };

  const context = await fetchChangeRequestContext(octokit, { owner, repo, number: job.changeRequestNumber });
  const outcome = await generateExplain(ctx.llmModel, {
    title: context.title,
    body: context.body,
    diff: context.diff,
  });

  await postOrUpdateMarkedComment(ctx, octokit, target, EXPLAIN_COMMENT_MARKER, formatExplainComment(outcome.result));

  await recordLlmUsage(ctx.sql, {
    jobId: job.id,
    model: ctx.config.LLM_MODEL,
    inputTokens: outcome.inputTokens,
    outputTokens: outcome.outputTokens,
  });
}

async function runChangeRequestReview(ctx: WorkerContext, job: ReviewJob, owner: string, repo: string): Promise<void> {
  if (job.changeRequestNumber == null) throw new Error('change_request_review job missing changeRequestNumber');

  const octokit = await getInstallationOctokitForRepo(ctx.githubApp, job.repositoryFullName);
  const pullNumber = job.changeRequestNumber;

  const context = await fetchChangeRequestContext(octokit, { owner, repo, number: pullNumber });
  const validAnchors = parseDiffAnchors(context.diff);

  const outcome = await generateReview(ctx.llmModel, {
    title: context.title,
    body: context.body,
    diff: context.diff,
  });

  const existingComments = await listReviewComments(octokit, { owner, repo, pullNumber });
  const existingAnchors = new Set(
    existingComments
      .filter((c): c is { path: string; line: number; side: string } => c.line != null && c.side != null)
      .map((c) => `${c.path}:${c.line}:${c.side}`),
  );

  const selected = selectReviewFindings(outcome.result.findings, validAnchors, existingAnchors);

  await createPullRequestReview(octokit, {
    owner,
    repo,
    pullNumber,
    body: outcome.result.summary,
    comments: selected.map((f) => ({ path: f.path, line: f.line, side: f.side, body: f.body })),
  });

  await recordLlmUsage(ctx.sql, {
    jobId: job.id,
    model: ctx.config.LLM_MODEL,
    inputTokens: outcome.inputTokens,
    outputTokens: outcome.outputTokens,
  });
}

export async function runJob(ctx: WorkerContext, job: ReviewJob): Promise<void> {
  const [owner, repo] = job.repositoryFullName.split('/');
  if (!owner || !repo) throw new Error(`Malformed repositoryFullName "${job.repositoryFullName}"`);

  switch (job.type) {
    case 'issue_triage':
      ctx.logger.info({ jobId: job.id, repository: job.repositoryFullName, issueNumber: job.issueNumber }, 'Running issue triage job');
      return runIssueTriage(ctx, job, owner, repo);
    case 'change_request_explain':
      ctx.logger.info({ jobId: job.id, repository: job.repositoryFullName, changeRequestNumber: job.changeRequestNumber }, 'Running change request explain job');
      return runChangeRequestExplain(ctx, job, owner, repo);
    case 'change_request_review':
      ctx.logger.info({ jobId: job.id, repository: job.repositoryFullName, changeRequestNumber: job.changeRequestNumber }, 'Running change request review job');
      return runChangeRequestReview(ctx, job, owner, repo);
    case 'review_thread_reply':
      ctx.logger.info({ jobId: job.id, repository: job.repositoryFullName, changeRequestNumber: job.changeRequestNumber }, 'Running review thread reply job');
      throw new Error(`No handler yet for job type "${job.type}"`);
  }
}
