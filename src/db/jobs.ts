import type { Sql } from './pool.js';
import type { NewReviewJob, ReviewJob } from '../domain/types.js';

interface ReviewJobRow {
  id: string;
  provider: 'github';
  type: ReviewJob['type'];
  status: ReviewJob['status'];
  repository_full_name: string;
  issue_number: number | null;
  change_request_number: number | null;
  head_sha: string | null;
  trigger_actor: string;
  dedupe_key: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  error_message: string | null;
}

function toReviewJob(row: ReviewJobRow): ReviewJob {
  return {
    id: row.id,
    provider: row.provider,
    type: row.type,
    status: row.status,
    repositoryFullName: row.repository_full_name,
    issueNumber: row.issue_number,
    changeRequestNumber: row.change_request_number,
    headSha: row.head_sha,
    triggerActor: row.trigger_actor,
    dedupeKey: row.dedupe_key,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorMessage: row.error_message,
  };
}

export interface WebhookDelivery {
  deliveryId: string;
  event: string;
  action?: string | undefined;
  repositoryFullName?: string | undefined;
}

/** Returns false if this delivery_id was already recorded (duplicate webhook delivery). */
export async function insertDelivery(sql: Sql, delivery: WebhookDelivery): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    insert into webhook_deliveries (delivery_id, event, action, repository_full_name)
    values (${delivery.deliveryId}, ${delivery.event}, ${delivery.action ?? null}, ${delivery.repositoryFullName ?? null})
    on conflict (delivery_id) do nothing
    returning id
  `;
  return rows.length > 0;
}

/** Returns null if a job with this dedupe_key already exists (duplicate trigger). */
export async function enqueueJob(sql: Sql, job: NewReviewJob): Promise<ReviewJob | null> {
  const rows = await sql<ReviewJobRow[]>`
    insert into review_jobs (
      provider, type, status, repository_full_name, issue_number,
      change_request_number, head_sha, trigger_actor, dedupe_key, payload
    ) values (
      ${job.provider}, ${job.type}, 'queued', ${job.repositoryFullName}, ${job.issueNumber ?? null},
      ${job.changeRequestNumber ?? null}, ${job.headSha ?? null}, ${job.triggerActor}, ${job.dedupeKey}, ${JSON.stringify(job.payload)}::jsonb
    )
    on conflict (dedupe_key) do nothing
    returning *
  `;
  return rows[0] ? toReviewJob(rows[0]) : null;
}

/** Claims the oldest queued job with SKIP LOCKED and marks it running. Returns null if no job is queued. */
export async function claimJob(sql: Sql): Promise<ReviewJob | null> {
  return sql.begin(async (tx) => {
    const rows = await tx<ReviewJobRow[]>`
      select * from review_jobs
      where status = 'queued'
      order by created_at
      limit 1
      for update skip locked
    `;
    const row = rows[0];
    if (!row) return null;

    const updated = await tx<ReviewJobRow[]>`
      update review_jobs
      set status = 'running', started_at = now(), attempts = attempts + 1
      where id = ${row.id}
      returning *
    `;
    return updated[0] ? toReviewJob(updated[0]) : null;
  });
}

export async function completeJob(sql: Sql, id: string): Promise<void> {
  await sql`
    update review_jobs
    set status = 'done', finished_at = now()
    where id = ${id}
  `;
}

/** Marks a job failed. Re-queues it if attempts remain, otherwise marks it dead. */
export async function failJob(sql: Sql, id: string, errorMessage: string): Promise<void> {
  await sql`
    update review_jobs
    set
      status = case when attempts < max_attempts then 'queued' else 'dead' end,
      finished_at = case when attempts < max_attempts then null else now() end,
      error_message = ${errorMessage}
    where id = ${id}
  `;
}

/** Marks a job permanently dead regardless of remaining attempts (e.g. GitHub 401/403/404). */
export async function killJob(sql: Sql, id: string, errorMessage: string): Promise<void> {
  await sql`
    update review_jobs
    set status = 'dead', finished_at = now(), error_message = ${errorMessage}
    where id = ${id}
  `;
}

export async function recordLlmUsage(
  sql: Sql,
  usage: { jobId: string; model: string; inputTokens: number; outputTokens: number },
): Promise<void> {
  await sql`
    insert into llm_usage (job_id, model, input_tokens, output_tokens)
    values (${usage.jobId}, ${usage.model}, ${usage.inputTokens}, ${usage.outputTokens})
  `;
}
