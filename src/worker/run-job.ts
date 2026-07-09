import type { App } from '@octokit/app';
import type { Logger } from 'pino';
import { recordLlmUsage } from '../db/jobs.js';
import type { Sql } from '../db/pool.js';
import type { WorkerConfig } from '../domain/config.js';
import type { ReviewJob } from '../domain/types.js';
import { getInstallationOctokitForRepo } from '../github/auth.js';
import { fetchIssueContext } from '../github/fetch-context.js';
import { listIssueComments, postIssueComment, updateIssueComment } from '../github/publish.js';
import type { LlmModel } from '../llm/client.js';
import { formatTriageComment, generateTriage } from '../llm/triage.js';

export interface WorkerContext {
  sql: Sql;
  githubApp: App;
  config: WorkerConfig;
  logger: Logger;
  llmModel: LlmModel;
}

const TRIAGE_COMMENT_MARKER = '### AI triage';

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
  const body = formatTriageComment(outcome.result);

  // Anti-spam: update our own prior triage comment on this issue instead of
  // posting a new one every time triage is re-triggered.
  const existingComments = await listIssueComments(octokit, target);
  const priorComment = existingComments.find(
    (c) => c.user?.login === ctx.config.GITHUB_BOT_LOGIN && c.body?.startsWith(TRIAGE_COMMENT_MARKER),
  );

  if (priorComment) {
    await updateIssueComment(octokit, { owner, repo, commentId: priorComment.id, body });
  } else {
    await postIssueComment(octokit, { ...target, body });
  }

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
      return runIssueTriage(ctx, job, owner, repo);
    case 'change_request_explain':
    case 'change_request_review':
    case 'review_thread_reply':
      throw new Error(`No handler yet for job type "${job.type}"`);
  }
}
