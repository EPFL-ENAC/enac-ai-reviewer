import type { InstallationOctokit } from './auth.js';

export interface IssueContext {
  title: string;
  body: string;
  labels: string[];
  comments: { author: string; body: string }[];
}

const MAX_BODY_CHARS = 6000;
const MAX_COMMENTS = 10;
const MAX_COMMENT_CHARS = 1000;

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n… (truncated)`;
}

export async function fetchIssueContext(
  octokit: InstallationOctokit,
  target: { owner: string; repo: string; issueNumber: number },
): Promise<IssueContext> {
  const { data: issue } = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
    owner: target.owner,
    repo: target.repo,
    issue_number: target.issueNumber,
  });

  const { data: comments } = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
    owner: target.owner,
    repo: target.repo,
    issue_number: target.issueNumber,
    per_page: MAX_COMMENTS,
  });

  return {
    title: issue.title,
    body: truncate(issue.body ?? '', MAX_BODY_CHARS),
    labels: issue.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
    comments: comments.slice(-MAX_COMMENTS).map((c) => ({
      author: c.user?.login ?? 'unknown',
      body: truncate(c.body ?? '', MAX_COMMENT_CHARS),
    })),
  };
}
