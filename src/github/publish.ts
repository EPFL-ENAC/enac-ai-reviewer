import type { InstallationOctokit } from './auth.js';

export interface IssueCommentTarget {
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
}

export async function postIssueComment(octokit: InstallationOctokit, target: IssueCommentTarget): Promise<void> {
  await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
    owner: target.owner,
    repo: target.repo,
    issue_number: target.issueNumber,
    body: target.body,
  });
}

export async function listIssueComments(
  octokit: InstallationOctokit,
  target: { owner: string; repo: string; issueNumber: number },
): Promise<{ id: number; body?: string; user: { login: string } | null }[]> {
  const { data } = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
    owner: target.owner,
    repo: target.repo,
    issue_number: target.issueNumber,
    per_page: 100,
  });
  return data;
}

export async function updateIssueComment(
  octokit: InstallationOctokit,
  target: { owner: string; repo: string; commentId: number; body: string },
): Promise<void> {
  await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
    owner: target.owner,
    repo: target.repo,
    comment_id: target.commentId,
    body: target.body,
  });
}

export async function listReviewComments(
  octokit: InstallationOctokit,
  target: { owner: string; repo: string; pullNumber: number },
): Promise<{ path: string; line?: number; side?: string }[]> {
  const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/comments', {
    owner: target.owner,
    repo: target.repo,
    pull_number: target.pullNumber,
    per_page: 100,
  });
  return data;
}

export interface PullRequestReviewComment {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  body: string;
}

/** Posts exactly one PR review with event COMMENT. Never APPROVE or REQUEST_CHANGES in v1 (PRD §12). */
export async function createPullRequestReview(
  octokit: InstallationOctokit,
  target: { owner: string; repo: string; pullNumber: number; body: string; comments: PullRequestReviewComment[] },
): Promise<void> {
  await octokit.request('POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
    owner: target.owner,
    repo: target.repo,
    pull_number: target.pullNumber,
    event: 'COMMENT',
    body: target.body,
    comments: target.comments,
  });
}
