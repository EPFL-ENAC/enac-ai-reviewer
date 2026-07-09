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

export interface ChangeRequestContext {
  title: string;
  body: string;
  headSha: string;
  diff: string;
}

const LOCK_FILE_PATTERNS = [
  /package-lock\.json$/,
  /pnpm-lock\.yaml$/,
  /yarn\.lock$/,
  /Gemfile\.lock$/,
  /composer\.lock$/,
  /Cargo\.lock$/,
  /poetry\.lock$/,
];
const GENERATED_FILE_PATTERNS = [/\.min\.(js|css)$/, /(^|\/)dist\//, /\.generated\./, /(^|\/)vendor\//];
const MAX_DIFF_CHARS = 20000;

/** Drops diff sections for lock files and generated files (PRD §12: "skip lock files and generated files"). */
export function filterDiff(diff: string): string {
  const sections = diff.split(/(?=^diff --git )/m);
  return sections
    .filter((section) => {
      const path = /^diff --git a\/(.+?) b\//m.exec(section)?.[1] ?? '';
      if (LOCK_FILE_PATTERNS.some((p) => p.test(path))) return false;
      if (GENERATED_FILE_PATTERNS.some((p) => p.test(path))) return false;
      return true;
    })
    .join('');
}

export async function fetchChangeRequestContext(
  octokit: InstallationOctokit,
  target: { owner: string; repo: string; number: number },
): Promise<ChangeRequestContext> {
  const { data: pr } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner: target.owner,
    repo: target.repo,
    pull_number: target.number,
  });

  const rawDiff = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner: target.owner,
    repo: target.repo,
    pull_number: target.number,
    mediaType: { format: 'diff' },
  });

  return {
    title: pr.title,
    body: truncate(pr.body ?? '', MAX_BODY_CHARS),
    headSha: pr.head.sha,
    diff: truncate(filterDiff(rawDiff.data as unknown as string), MAX_DIFF_CHARS),
  };
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
