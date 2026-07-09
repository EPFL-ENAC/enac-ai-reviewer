-- Up Migration

create extension if not exists pgcrypto;

create table webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'github',
  delivery_id text not null unique,
  event text not null,
  action text,
  repository_full_name text,
  received_at timestamptz not null default now()
);

create table review_jobs (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'github',
  type text not null,
  status text not null,
  repository_full_name text not null,
  issue_number int,
  change_request_number int,
  head_sha text,
  trigger_actor text not null,
  dedupe_key text not null unique,
  payload jsonb not null,
  attempts int not null default 0,
  max_attempts int not null default 3,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  error_message text
);

create index review_jobs_status_created_at_idx on review_jobs (status, created_at);

create table llm_usage (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references review_jobs(id),
  model text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  created_at timestamptz not null default now()
);

-- Down Migration

drop table llm_usage;
drop table review_jobs;
drop table webhook_deliveries;
