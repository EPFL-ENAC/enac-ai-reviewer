import type { JobTrace } from '../../db/jobs.js';
import type { ReviewJob } from '../../domain/types.js';

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

function layout(title: string, body: string, refreshUrl?: string): string {
  const refresh = refreshUrl
    ? `<meta http-equiv="refresh" content="10;url=${escapeHtml(refreshUrl)}">`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${refresh}
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 2rem; line-height: 1.5; }
    h1, h2 { margin-top: 0; }
    a { color: #0969da; text-decoration: none; }
    a:hover { text-decoration: underline; }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
    th, td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid #d0d7de; }
    th { font-weight: 600; background: #f6f8fa; }
    tr:hover { background: #f6f8fa; }
    .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; }
    .status-queued { background: #fff8c5; color: #7a4d00; }
    .status-running { background: #ddf4ff; color: #0a55a8; }
    .status-done { background: #dafbe1; color: #106024; }
    .status-dead { background: #ffebe9; color: #842326; }
    .status-other { background: #f6f8fa; color: #57606a; }
    .counts { display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 1rem 0; }
    .count { padding: 0.25rem 0.75rem; border-radius: 999px; background: #f6f8fa; border: 1px solid #d0d7de; }
    .count.active { background: #ddf4ff; border-color: #79c0ff; }
    .pagination { margin-top: 1rem; display: flex; gap: 1rem; align-items: center; }
    .trace { margin: 1rem 0; padding: 1rem; border: 1px solid #d0d7de; border-radius: 0.5rem; }
    .trace-header { display: flex; gap: 0.75rem; align-items: baseline; margin-bottom: 0.75rem; }
    .trace-time { color: #57606a; font-size: 0.85rem; }
    .trace-type { font-weight: 600; }
    pre { background: #f6f8fa; padding: 1rem; border-radius: 0.375rem; overflow-x: auto; font-size: 0.875rem; }
    .back { margin-bottom: 1rem; display: inline-block; }
    .empty { color: #57606a; font-style: italic; }
  </style>
</head>
<body>
  ${body}
</body>
</html>`;
}

export function renderJobsList(opts: {
  jobs: ReviewJob[];
  counts: Record<string, number>;
  statusFilter?: string;
  page: number;
  pageSize: number;
  total: number;
  basePath: string;
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
      </tr>`;
    })
    .join('');

  const totalPages = Math.max(1, Math.ceil(opts.total / opts.pageSize));
  const prevUrl = opts.page > 1 ? buildListUrl(opts.basePath, opts.statusFilter, opts.page - 1, opts.pageSize) : undefined;
  const nextUrl = opts.page < totalPages ? buildListUrl(opts.basePath, opts.statusFilter, opts.page + 1, opts.pageSize) : undefined;
  const prevLink = prevUrl ? `<a href="${prevUrl}">← Previous</a>` : '<span style="color:#57606a">← Previous</span>';
  const nextLink = nextUrl ? `<a href="${nextUrl}">Next →</a>` : '<span style="color:#57606a">Next →</span>';

  const querySuffix = opts.statusFilter ? `?status=${opts.statusFilter}` : '';
  const refreshUrl = `${opts.basePath}${querySuffix}`;

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
        </tr>
      </thead>
      <tbody>
        ${rows || '<tr><td colspan="8" class="empty">No jobs found.</td></tr>'}
      </tbody>
    </table>
    <div class="pagination">
      ${prevLink}
      <span>Page ${opts.page} of ${totalPages}</span>
      ${nextLink}
    </div>
  `;

  return layout('Admin — Jobs', body, refreshUrl);
}

function buildListUrl(basePath: string, status: string | undefined, page: number, pageSize: number): string {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (page > 1) params.set('page', String(page));
  if (pageSize !== 50) params.set('pageSize', String(pageSize));
  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}

export function renderJobDetail(opts: { job: ReviewJob; traces: JobTrace[]; basePath: string }): string {
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

  return layout(`Admin — Job ${job.id.slice(0, 8)}`, body, refreshUrl);
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
