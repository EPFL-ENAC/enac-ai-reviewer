-- Up Migration

-- W3C trace context of the request that enqueued the job. The web process
-- injects it at enqueue time; the worker continues that trace when it claims
-- the job, so a review is one trace across both processes (src/otel.ts).
alter table review_jobs add column traceparent text;

-- Down Migration

alter table review_jobs drop column traceparent;
