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

export type FileFetchResult =
  | { status: 'fetched'; content: string }
  | { status: 'not_found' }
  | { status: 'binary_skipped' }
  | { status: 'too_large' }
  | { status: 'skipped_generated' }
  | { status: 'budget_exhausted' };

const MAX_AGENT_FILE_CHARS = 8000;
const MAX_AGENT_TOTAL_FILE_CHARS = 24000;

/** Filters the file paths the LLM asked for: drops empty, absolute, traversal-style, backslashed and duplicate paths. */
export function sanitizeRequestedPaths(paths: string[]): string[] {
  const cleaned: string[] = [];
  for (const raw of paths) {
    const path = raw.trim().replace(/^\.\//, '');
    if (!path) continue;
    if (path.startsWith('/') || path.includes('\\')) continue;
    if (path.split('/').includes('..')) continue;
    if (!cleaned.includes(path)) cleaned.push(path);
  }
  return cleaned;
}

/**
 * Fetches file contents at a fixed ref for the review agent. Missing, binary, oversized, generated and
 * budget-exhausted files are reported per path instead of failing the job.
 */
export async function fetchFileContents(
  octokit: InstallationOctokit,
  target: { owner: string; repo: string; ref: string },
  paths: string[],
): Promise<Map<string, FileFetchResult>> {
  const results = new Map<string, FileFetchResult>();
  let totalChars = 0;

  for (const path of paths) {
    if (totalChars >= MAX_AGENT_TOTAL_FILE_CHARS) {
      results.set(path, { status: 'budget_exhausted' });
      continue;
    }
    if (LOCK_FILE_PATTERNS.some((p) => p.test(path)) || GENERATED_FILE_PATTERNS.some((p) => p.test(path))) {
      results.set(path, { status: 'skipped_generated' });
      continue;
    }

    let file: { type?: string; size?: number; content?: string | null };
    try {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner: target.owner,
        repo: target.repo,
        path,
        ref: target.ref,
      });
      if (Array.isArray(data) || (data as { type?: string }).type !== 'file') {
        results.set(path, { status: 'not_found' });
        continue;
      }
      file = data as { type?: string; size?: number; content?: string | null };
    } catch (error) {
      if ((error as { status?: number }).status === 404) {
        results.set(path, { status: 'not_found' });
        continue;
      }
      throw error;
    }

    if (!file.content) {
      results.set(path, { status: (file.size ?? 0) > 0 ? 'too_large' : 'not_found' });
      continue;
    }

    const text = Buffer.from(file.content, 'base64').toString('utf8');
    if (text.includes('\u0000')) {
      results.set(path, { status: 'binary_skipped' });
      continue;
    }
    if (text.length > MAX_AGENT_FILE_CHARS) {
      results.set(path, { status: 'too_large' });
      continue;
    }

    const remaining = MAX_AGENT_TOTAL_FILE_CHARS - totalChars;
    const content = text.length > remaining ? `${text.slice(0, remaining)}\n… (truncated)` : text;
    totalChars += content.length;
    results.set(path, { status: 'fetched', content });
  }

  return results;
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
