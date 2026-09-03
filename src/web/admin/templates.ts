import type { JobTrace } from '../../db/jobs.js';
import type { ReviewJob } from '../../domain/types.js';
import type { AdminUser } from './auth.js';

function escapeHtml(raw: string): string {
  return raw
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDate(date: Date | string | null | undefined): string {
  if (!date) return '-';
  return new Date(date).toLocaleString();
}

function statusClass(status: string): string {
  switch (status) {
    case 'queued':
      return 'status-queued';
    case 'running':
      return 'status-running';
    case 'done':
      return 'status-done';
    case 'dead':
      return 'status-dead';
    default:
      return 'status-other';
  }
}

function githubRepoUrl(repo: string): string {
  return `https://github.com/${repo}`;
}

function githubIssueUrl(repo: string, issueNumber: number): string {
  return `${githubRepoUrl(repo)}/issues/${issueNumber}`;
}

function githubPullUrl(repo: string, pullNumber: number): string {
  return `${githubRepoUrl(repo)}/pull/${pullNumber}`;
}

function layout(title: string, body: string, refreshUrl?: string, user?: AdminUser): string {
  const refresh = refreshUrl
    ? `<meta http-equiv="refresh" content="10;url=${escapeHtml(refreshUrl)}">`
    : '';
  const userHtml = user
    ? `<span class="topbar-user">${escapeHtml(user.user)} <a href="/admin/logout">Log out</a></span>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${refresh}
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --epfl-red: #ff0000;
      --epfl-black: #212121;
      --epfl-white: #ffffff;
      --epfl-gray-100: #e6e6e6;
      --epfl-gray-200: #d5d5d5;
      --epfl-gray-300: #c1c1c1;
      --epfl-gray-500: #8e8e8e;
      --epfl-gray-600: #707070;
      --epfl-leman: #00A79F;
      --epfl-canard: #007480;
    }
    body { font-family: Arial, Helvetica, sans-serif; margin: 0; padding: 0; line-height: 1.5; color: var(--epfl-black); background: var(--epfl-white); }
    .topbar { background: var(--epfl-red); color: var(--epfl-white); padding: 0.75rem 2rem; display: flex; align-items: center; gap: 1rem; }
    .topbar-logo { font-size: 1.5rem; font-weight: 700; letter-spacing: -0.02em; text-decoration: none; color: var(--epfl-white); }
    .topbar-title { font-size: 1rem; font-weight: 400; opacity: 0.95; }
    .topbar-user { margin-left: auto; font-size: 0.875rem; }
    .topbar-user a { color: var(--epfl-white); }
    .container { padding: 2rem; max-width: 1200px; margin: 0 auto; }
    h1, h2 { margin-top: 0; color: var(--epfl-black); }
    h1 { font-weight: 400; border-bottom: 2px solid var(--epfl-red); padding-bottom: 0.5rem; margin-bottom: 1rem; }
    h2 { font-weight: 700; margin-top: 1.5rem; }
    a { color: var(--epfl-canard); text-decoration: underline; }
    a:hover { color: var(--epfl-leman); }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; border: 1px solid var(--epfl-gray-200); }
    th, td { padding: 0.6rem 0.75rem; text-align: left; border-bottom: 1px solid var(--epfl-gray-200); }
    th { font-weight: 700; background: var(--epfl-gray-100); }
    tr:hover { background: #f5f5f5; }
    code { font-family: monospace; background: var(--epfl-gray-100); padding: 0.125rem 0.25rem; border-radius: 2px; }
    .badge { display: inline-block; padding: 0.25em 0.5em; border-radius: 2px; font-size: 0.875rem; font-weight: 700; text-transform: uppercase; }
    .status-queued { background: var(--epfl-gray-100); color: var(--epfl-black); }
    .status-running { background: var(--epfl-leman); color: var(--epfl-white); }
    .status-done { background: var(--epfl-canard); color: var(--epfl-white); }
    .status-dead { background: var(--epfl-red); color: var(--epfl-white); }
    .status-other { background: var(--epfl-gray-300); color: var(--epfl-black); }
    .counts { display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 1rem 0; }
    .count { padding: 0.375rem 0.75rem; border-radius: 2px; background: var(--epfl-white); border: 1px solid var(--epfl-gray-200); color: var(--epfl-black); text-decoration: none; }
    .count:hover { background: var(--epfl-gray-100); }
    .count.active { background: var(--epfl-red); border-color: var(--epfl-red); color: var(--epfl-white); }
    .pagination { margin-top: 1rem; display: flex; gap: 1rem; align-items: center; }
    .actions { display: flex; gap: 0.5rem; }
    .action-form { margin: 0; }
    .btn { display: inline-block; border: 1px solid var(--epfl-red); background: var(--epfl-white); color: var(--epfl-red); padding: 0.25rem 0.75rem; border-radius: 2px; cursor: pointer; font-size: 0.875rem; font-weight: 700; text-transform: uppercase; font-family: Arial, Helvetica, sans-serif; }
    .btn:hover { background: var(--epfl-red); color: var(--epfl-white); }
    .btn-primary { background: var(--epfl-red); color: var(--epfl-white); }
    .btn-primary:hover { background: #cc0000; border-color: #cc0000; }
    .btn-secondary { border-color: var(--epfl-gray-500); color: var(--epfl-black); }
    .btn-secondary:hover { background: var(--epfl-gray-100); color: var(--epfl-black); }
    .action-bar { margin-bottom: 1rem; display: flex; gap: 0.5rem; }
    .trace { margin: 1rem 0; padding: 1rem; border: 1px solid var(--epfl-gray-200); border-radius: 2px; background: var(--epfl-white); }
    .trace-header { display: flex; gap: 0.75rem; align-items: baseline; margin-bottom: 0.75rem; }
    .trace-time { color: var(--epfl-gray-600); font-size: 0.875rem; }
    .trace-type { font-weight: 700; color: var(--epfl-red); text-transform: uppercase; font-size: 0.875rem; }
    pre { background: #f5f5f5; padding: 1rem; border-radius: 2px; overflow-x: auto; font-size: 0.875rem; border: 1px solid var(--epfl-gray-100); }
    .back { margin-bottom: 1rem; display: inline-block; }
    .empty { color: var(--epfl-gray-600); font-style: italic; }
  </style>
</head>
<body>
  <header class="topbar">
    <a href="/admin" class="topbar-logo">EPFL</a>
    <span class="topbar-title">AI Reviewer Admin</span>
    ${userHtml}
  </header>
  <div class="container">
    ${body}
  </div>
</body>
</html>`;
}

function renderActions(job: ReviewJob, basePath: string): string {
  const forms: string[] = [];
  if (job.status == 'queued' || job.status === 'running') {
    forms.push(
      `<form method="POST" action="${basePath}/${job.id}/cancel" class="action-form">` +
        `<button type="submit" class="btn btn-secondary">Cancel</button>` +
      `</form>`,
    );
  }
  if (job.status === 'dead' || job.status === 'failed') {
    forms.push(
      `<form method="POST" action="${basePath}/${job.id}/retry" class="action-form">` +
        `<button type="submit" class="btn btn-primary">Retry</button>` +
      `</form>`,
    );
  }
  return `<div class="actions">${forms.join('')}</div>`;
}

export function renderJobsList(opts: {
  jobs: ReviewJob[];
  counts: Record<string, number>;
  statusFilter?: string;
  page: number;
  pageSize: number;
  total: number;
  basePath: string;
  user?: AdminUser;
}): string {
  const statuses = ['queued', 'running', 'done', 'dead', 'failed'];
  const countLinks = statuses
    .map((status) => {
      const count = opts.counts[status] ?? 0;
      const active = opts.statusFilter === status;
      const href = active ? opts.basePath : `${opts.basePath}?status=${status}`;
      return `<a href="${href}" class="count ${active ? 'active' : ''}">${status}: ${count}</a>`;
    })
    .join('');

  const rows = opts.jobs
    .map((job) => {
      const detailUrl = `${opts.basePath}/${job.id}`;
      const repoLink = `<a href="${escapeHtml(githubRepoUrl(job.repositoryFullName))}" target="_blank">${escapeHtml(job.repositoryFullName)}</a>`;
      let targetLink = '-';
      if (job.issueNumber != null) {
        targetLink = `<a href="${escapeHtml(githubIssueUrl(job.repositoryFullName, job.issueNumber))}" target="_blank">issue #${job.issueNumber}</a>`;
      } else if (job.changeRequestNumber != null) {
        targetLink = `<a href="${escapeHtml(githubPullUrl(job.repositoryFullName, job.changeRequestNumber))}" target="_blank">PR #${job.changeRequestNumber}</a>`;
      }
      return `<tr>
        <td><a href="${detailUrl}">${job.id.slice(0, 8)}</a></td>
        <td><span class="badge ${statusClass(job.status)}">${escapeHtml(job.status)}</span></td>
        <td>${escapeHtml(job.type)}</td>
        <td>${repoLink}</td>
        <td>${targetLink}</td>
        <td>${escapeHtml(job.triggerActor)}</td>
        <td>${formatDate(job.createdAt)}</td>
        <td>${job.attempts}/${job.maxAttempts}</td>
        <td>${renderActions(job, opts.basePath)}</td>
      </tr>`;
    })
    .join('');

  const totalPages = Math.max(1, Math.ceil(opts.total / opts.pageSize));
  const prevUrl = opts.page > 1 ? buildListUrl(opts.basePath, opts.statusFilter, opts.page - 1, opts.pageSize) : undefined;
  const nextUrl = opts.page < totalPages ? buildListUrl(opts.basePath, opts.statusFilter, opts.page + 1, opts.pageSize) : undefined;
  const prevLink = prevUrl ? `<a href="${prevUrl}">← Previous</a>` : '<span style="color:#57606a">← Previous</span>';
  const nextLink = nextUrl ? `<a href="${nextUrl}">Next →</a>` : '<span style="color:#57606a">Next →</span>';

  const refreshParams = new URLSearchParams();
  if (opts.statusFilter) refreshParams.set('status', opts.statusFilter);
  if (opts.page !== 1) refreshParams.set('page', String(opts.page));
  if (opts.pageSize !== 50) refreshParams.set('pageSize', String(opts.pageSize));
  const refreshUrl = refreshParams.toString()
    ? `${opts.basePath}?${refreshParams.toString()}`
    : opts.basePath;

  const body = `
    <h1>Admin — Jobs</h1>
    <div class="counts">
      <a href="${opts.basePath}" class="count ${!opts.statusFilter ? 'active' : ''}">all: ${opts.total}</a>
      ${countLinks}
    </div>
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>Status</th>
          <th>Type</th>
          <th>Repository</th>
          <th>Target</th>
          <th>Actor</th>
          <th>Created</th>
          <th>Attempts</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${rows || '<tr><td colspan="9" class="empty">No jobs found.</td></tr>'}
      </tbody>
    </table>
    <div class="pagination">
      ${prevLink}
      <span>Page ${opts.page} of ${totalPages}</span>
      ${nextLink}
    </div>
  `;

  return layout('Admin — Jobs', body, refreshUrl, opts.user);
}

function buildListUrl(basePath: string, status: string | undefined, page: number, pageSize: number): string {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (page > 1) params.set('page', String(page));
  if (pageSize !== 50) params.set('pageSize', String(pageSize));
  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}

export function renderJobDetail(opts: { job: ReviewJob; traces: JobTrace[]; basePath: string; user?: AdminUser }): string {
  const job = opts.job;
  const repoLink = `<a href="${escapeHtml(githubRepoUrl(job.repositoryFullName))}" target="_blank">${escapeHtml(job.repositoryFullName)}</a>`;
  let targetRow = '';
  if (job.issueNumber != null) {
    targetRow = `<tr><th>Issue</th><td><a href="${escapeHtml(githubIssueUrl(job.repositoryFullName, job.issueNumber))}" target="_blank">#${job.issueNumber}</a></td></tr>`;
  } else if (job.changeRequestNumber != null) {
    targetRow = `<tr><th>Pull request</th><td><a href="${escapeHtml(githubPullUrl(job.repositoryFullName, job.changeRequestNumber))}" target="_blank">#${job.changeRequestNumber}</a></td></tr>`;
  }
  if (job.headSha) {
    targetRow += `<tr><th>Head SHA</th><td><code>${escapeHtml(job.headSha)}</code></td></tr>`;
  }

  const tracesHtml = opts.traces
    .map((trace) => {
      const payloadHtml = formatTracePayload(trace.type, trace.payload);
      return `<div class="trace">
        <div class="trace-header">
          <span class="trace-time">${formatDate(trace.createdAt)}</span>
          <span class="trace-type">${escapeHtml(trace.type)}</span>
        </div>
        ${payloadHtml}
      </div>`;
    })
    .join('');

  const refreshUrl = `${opts.basePath}/${job.id}`;

  const body = `
    <a href="${opts.basePath}" class="back">← Back to jobs</a>
    <h1>Job ${job.id.slice(0, 8)}</h1>
    <div class="action-bar">
      ${renderActions(job, opts.basePath)}
    </div>
    <table>
      <tbody>
        <tr><th>ID</th><td><code>${job.id}</code></td></tr>
        <tr><th>Status</th><td><span class="badge ${statusClass(job.status)}">${escapeHtml(job.status)}</span></td></tr>
        <tr><th>Type</th><td>${escapeHtml(job.type)}</td></tr>
        <tr><th>Repository</th><td>${repoLink}</td></tr>
        ${targetRow}
        <tr><th>Actor</th><td>${escapeHtml(job.triggerActor)}</td></tr>
        <tr><th>Dedupe key</th><td><code>${escapeHtml(job.dedupeKey)}</code></td></tr>
        <tr><th>Created</th><td>${formatDate(job.createdAt)}</td></tr>
        <tr><th>Started</th><td>${formatDate(job.startedAt)}</td></tr>
        <tr><th>Finished</th><td>${formatDate(job.finishedAt)}</td></tr>
        <tr><th>Attempts</th><td>${job.attempts}/${job.maxAttempts}</td></tr>
        ${job.errorMessage ? `<tr><th>Error</th><td style="color:#842326">${escapeHtml(job.errorMessage)}</td></tr>` : ''}
      </tbody>
    </table>
    <h2>Trace</h2>
    ${tracesHtml || '<p class="empty">No trace events yet.</p>'}
  `;

  return layout(`Admin — Job ${job.id.slice(0, 8)}`, body, refreshUrl, opts.user);
}

function formatTracePayload(type: string, payload: unknown): string {
  if (payload == null || (typeof payload === 'object' && Object.keys(payload).length === 0)) {
    return '';
  }
  if (type === 'llm_prompt' && typeof payload === 'object' && payload !== null && 'prompt' in payload) {
    const prompt = (payload as { prompt: unknown }).prompt;
    return `<pre>${escapeHtml(String(prompt))}</pre>`;
  }
  return `<pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>`;
}
