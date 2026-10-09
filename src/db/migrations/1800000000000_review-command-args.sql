-- Up Migration

alter table review_jobs add column command_args jsonb;

-- Down Migration

alter table review_jobs drop column command_args;
