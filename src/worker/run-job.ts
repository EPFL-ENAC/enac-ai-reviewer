import type { App } from '@octokit/app';
import type { Logger } from 'pino';
import type { Sql } from '../db/pool.js';
import type { WorkerConfig } from '../domain/config.js';
import type { ReviewJob } from '../domain/types.js';
import { getInstallationOctokitForRepo } from '../github/auth.js';
import { postIssueComment } from '../github/publish.js';

export interface WorkerContext {
  sql: Sql;
  githubApp: App;
  config: WorkerConfig;
  logger: Logger;
}

export async function runJob(ctx: WorkerContext, job: ReviewJob): Promise<void> {
  const [owner, repo] = job.repositoryFullName.split('/');
  if (!owner || !repo) throw new Error(`Malformed repositoryFullName "${job.repositoryFullName}"`);

  const octokit = await getInstallationOctokitForRepo(ctx.githubApp, job.repositoryFullName);

  switch (job.type) {
    case 'issue_triage': {
      if (job.issueNumber == null) throw new Error('issue_triage job missing issueNumber');
      // Phase 3 milestone: prove webhook -> queue -> worker -> App auth -> posting
      // end-to-end before wiring in the LLM. Phase 4 replaces this body with a
      // real call to llm/triage.ts.
      await postIssueComment(octokit, {
        owner,
        repo,
        issueNumber: job.issueNumber,
        body: '### AI triage\n\n_(placeholder — LLM-backed triage lands in Phase 4)_',
      });
      return;
    }
    case 'change_request_explain':
    case 'change_request_review':
    case 'review_thread_reply':
      throw new Error(`No handler yet for job type "${job.type}"`);
  }
}
