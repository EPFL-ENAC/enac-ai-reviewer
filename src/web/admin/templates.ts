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
  return new Date(date).toLocaleString("fr-CH", { timeZone: "Europe/Zurich" });
}

function statusClass(status: string): string {
  switch (status) {
    case 'queued':
      return 'admin-status-queued';
    case 'running':
      return 'admin-status-running';
    case 'done':
      return 'admin-status-done';
    case 'dead':
      return 'admin-status-dead';
    case 'failed':
      return 'admin-status-failed';
    default:
      return 'admin-status-queued';
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
    ? `<span class="admin-topbar-user">${escapeHtml(user.user)} <a href="/admin/logout" class="epfl-btn epfl-btn-secondary epfl-btn-sm">Log out</a></span>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${refresh}
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/admin/assets/epfl.css">
  <link rel="stylesheet" href="/admin/assets/admin.css">
</head>
<body>
  <header class="epfl-header admin-topbar">
    <a href="/admin" class="epfl-logo"><img src="/admin/assets/epfl-logo.svg" alt="EPFL"></a>
    <span class="admin-topbar-module">AI Reviewer Admin</span>
    ${userHtml}
  </header>
  <div class="admin-container">
    ${body}
  </div>
</body>
</html>`;
}

export function renderMessagePage(opts: {
  title: string;
  heading: string;
  message: string;
  variant?: 'info' | 'danger';
  user?: AdminUser;
}): string {
  const variant = opts.variant ?? 'info';
  const body = `
    <div class="admin-message">
      <div class="epfl-alert epfl-alert-${variant}">
        <h1 class="h4">${escapeHtml(opts.heading)}</h1>
        <p>${opts.message}</p>
      </div>
    </div>
  `;
  return layout(opts.title, body, undefined, opts.user);
}

function renderActions(job: ReviewJob, basePath: string): string {
  const forms: string[] = [];
  if (job.status == 'queued' || job.status === 'running') {
    forms.push(
      `<form method="POST" action="${basePath}/${job.id}/cancel" class="admin-action-form">` +
        `<button type="submit" class="epfl-btn epfl-btn-secondary epfl-btn-sm">Cancel</button>` +
      `</form>`,
    );
  }
  if (job.status === 'dead' || job.status === 'failed') {
    forms.push(
      `<form method="POST" action="${basePath}/${job.id}/retry" class="admin-action-form">` +
        `<button type="submit" class="epfl-btn epfl-btn-primary epfl-btn-sm">Retry</button>` +
      `</form>`,
    );
  }
  return `<div class="admin-actions">${forms.join('')}</div>`;
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
      return `<a href="${href}" class="epfl-tag admin-filter ${active ? 'active' : ''}">${status}: ${count}</a>`;
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
        <td><span class="admin-status ${statusClass(job.status)}">${escapeHtml(job.status)}</span></td>
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
  const prevLink = prevUrl ? `<a href="${prevUrl}">← Previous</a>` : '<span class="admin-pagination-disabled">← Previous</span>';
  const nextLink = nextUrl ? `<a href="${nextUrl}">Next →</a>` : '<span class="admin-pagination-disabled">Next →</span>';

  const refreshParams = new URLSearchParams();
  if (opts.statusFilter) refreshParams.set('status', opts.statusFilter);
  if (opts.page !== 1) refreshParams.set('page', String(opts.page));
  if (opts.pageSize !== 50) refreshParams.set('pageSize', String(opts.pageSize));
  const refreshUrl = refreshParams.toString()
    ? `${opts.basePath}?${refreshParams.toString()}`
    : opts.basePath;

  const body = `
    <h1 class="admin-page-title">Admin — Jobs</h1>
    <div class="admin-filters">
      <a href="${opts.basePath}" class="epfl-tag admin-filter ${!opts.statusFilter ? 'active' : ''}">all: ${opts.total}</a>
      ${countLinks}
    </div>
    <table class="admin-table">
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
        ${rows || '<tr><td colspan="9" class="admin-empty">No jobs found.</td></tr>'}
      </tbody>
    </table>
    <div class="admin-pagination">
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
      return `<div class="admin-trace">
        <div class="admin-trace-header">
          <span class="admin-trace-time">${formatDate(trace.createdAt)}</span>
          <span class="admin-trace-type">${escapeHtml(trace.type)}</span>
        </div>
        ${payloadHtml}
      </div>`;
    })
    .join('');

  const refreshUrl = `${opts.basePath}/${job.id}`;

  const errorHtml = job.errorMessage
    ? `<div class="epfl-alert epfl-alert-danger"><b>Error</b> ${escapeHtml(job.errorMessage)}</div>`
    : '';

  const body = `
    <a href="${opts.basePath}" class="admin-back">← Back to jobs</a>
    <h1 class="admin-page-title">Job ${job.id.slice(0, 8)}</h1>
    <div class="admin-actions admin-detail-actions">
      ${renderActions(job, opts.basePath)}
    </div>
    ${errorHtml}
    <table class="admin-detail-table">
      <tbody>
        <tr><th>ID</th><td><code>${job.id}</code></td></tr>
        <tr><th>Status</th><td><span class="admin-status ${statusClass(job.status)}">${escapeHtml(job.status)}</span></td></tr>
        <tr><th>Type</th><td>${escapeHtml(job.type)}</td></tr>
        <tr><th>Repository</th><td>${repoLink}</td></tr>
        ${targetRow}
        <tr><th>Actor</th><td>${escapeHtml(job.triggerActor)}</td></tr>
        <tr><th>Dedupe key</th><td><code>${escapeHtml(job.dedupeKey)}</code></td></tr>
        <tr><th>Created</th><td>${formatDate(job.createdAt)}</td></tr>
        <tr><th>Started</th><td>${formatDate(job.startedAt)}</td></tr>
        <tr><th>Finished</th><td>${formatDate(job.finishedAt)}</td></tr>
        <tr><th>Attempts</th><td>${job.attempts}/${job.maxAttempts}</td></tr>
      </tbody>
    </table>
    <h2 class="h5">Trace</h2>
    ${tracesHtml || '<p class="admin-empty">No trace events yet.</p>'}
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
