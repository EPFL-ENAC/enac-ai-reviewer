-- Up Migration

create table job_traces (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references review_jobs(id) on delete cascade,
  type text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index job_traces_job_id_created_at_idx on job_traces (job_id, created_at);

-- Down Migration

drop table job_traces;
