# PRD: Minimal Self-Hosted AI Review Bot

## 1. Summary

Build a small self-hosted AI bot for GitHub issues and pull requests.

The bot receives GitHub webhooks, validates them, stores jobs in Postgres, runs a worker, calls an OpenAI-compatible LLM endpoint, and posts results back to GitHub.

The design should work for GitHub now without making a future GitLab migration stupidly painful.

## 2. Guiding principle

Do not build a generic SCM platform yet.

Build the GitHub version, but keep GitHub-specific code contained.

Use neutral domain names where cheap:

```text
change_request instead of pull_request
scm_provider instead of hardcoding github in every table
review_job instead of github_review_job
```

Do not create a GitLab adapter until EPFL GitLab is actually needed.

## 3. Goals

The bot shall:

1. Receive GitHub webhooks.
2. Validate GitHub webhook signatures.
3. React to explicit triggers:

   * `@bot review`
   * `@bot explain`
   * `@bot triage`
   * label `ai-review`
   * label `ai-triage`
   * assignment to bot user
4. Queue work in Postgres.
5. Process work asynchronously.
6. Call an OpenAI-compatible LLM endpoint protected by bearer token.
7. Post concise results back to GitHub.
8. Avoid duplicate jobs.
9. Avoid comment spam.
10. Keep GitHub-specific logic isolated in one package/folder.

## 4. Non-goals

Do not build in v1:

1. GitLab support.
2. Provider plugin architecture.
3. Redis queue.
4. Admin dashboard.
5. Web UI.
6. Auto-merge.
7. Auto-approve.
8. Auto-push commits.
9. Multi-agent workflows.
10. Full repository indexing.
11. RAG.
12. Long-term prompt storage.
13. Complex permission system.

## 5. Runtime shape

One repository.

One Docker image.

Two commands:

```text
npm run start:web
npm run start:worker
```

Kubernetes:

```text
Deployment ai-review-web
Deployment ai-review-worker
Service ai-review-web
Ingress /webhooks/github
Postgres
```

The web process must not call the LLM.

The worker process must not be publicly exposed.

### Minimal architecture

```text
GitHub webhook
   ↓
web process
   - validate HMAC
   - dedupe delivery id
   - parse command / label / assignment
   - insert job in Postgres
   - return 202

Postgres jobs table
   ↓
worker process
   - claim job with SKIP LOCKED
   - fetch PR / issue context via GitHub App token
   - call OpenAI-compatible LLM
   - post one comment or one PR review
   - mark job done
```

No Redis. No generic SCM framework. No GitLab adapter now. No admin API now. No dashboard now. Add when Postgres queue or logs become painful.

## 6. Package structure

```text
src/
  web/
    server.ts
    github-webhook.ts

  worker/
    worker.ts
    claim-job.ts
    run-job.ts

  github/
    auth.ts
    fetch-context.ts
    publish.ts
    map-event.ts

  llm/
    client.ts
    review.ts
    triage.ts

  db/
    jobs.ts
    migrations/

  domain/
    types.ts
    commands.ts
```

Do not create `src/gitlab` yet.

Do not create an abstract `ScmClient` interface yet.

When GitLab arrives, extract the interface from the real second implementation.

## 7. Database

Use Postgres as the queue.

### `webhook_deliveries`

```sql
create table webhook_deliveries (
  id uuid primary key,
  provider text not null default 'github',
  delivery_id text not null unique,
  event text not null,
  action text,
  repository_full_name text,
  received_at timestamptz not null default now()
);
```

### `review_jobs`

```sql
create table review_jobs (
  id uuid primary key,
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
```

### `llm_usage`

```sql
create table llm_usage (
  id uuid primary key,
  job_id uuid not null references review_jobs(id),
  model text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  created_at timestamptz not null default now()
);
```

That is enough for v1.

## 8. Job claiming

Workers claim jobs with Postgres row locking.

```sql
select *
from review_jobs
where status = 'queued'
order by created_at
limit 1
for update skip locked;
```

Then mark it running.

This is enough until throughput proves otherwise.

## 9. Supported job types

```text
issue_triage
change_request_explain
change_request_review
review_thread_reply
```

Use `change_request` internally.

Render as “PR” in GitHub comments.

If GitLab comes later, render as “MR”.

## 10. Triggers

### Mention

```text
@enac-ai-reviewer review
@enac-ai-reviewer explain
@enac-ai-reviewer triage
```

### Labels

```text
ai-review
ai-triage
```

### Assignment

If assigned to bot user:

```text
issue  → triage
PR     → review
```

Assignment requires a normal bot user if you want the GitHub UI to show an assignable identity.

The GitHub App remains the automation identity.

## 11. Security

### GitHub webhook

Validate:

```text
X-Hub-Signature-256
```

Use raw request body.

Use timing-safe comparison.

Reject invalid signatures.

Dedupe by:

```text
X-GitHub-Delivery
```

### LLM API

Use bearer token:

```text
Authorization: Bearer <LLM_API_KEY>
```

Only the worker gets this secret.

The public webhook service does not need the LLM token.

### Organization allowlist

Use a simple env/config allowlist:

```text
ALLOWED_ORGANIZATIONS=EPFL-ENAC
```

Ignore everything else.

## 12. Review behavior

The bot should be conservative.

Rules:

1. Comment only on changed lines.
2. Prefer one PR review over many issue comments.
3. Max 8 inline comments per run.
4. Drop low-confidence findings.
5. Skip lock files and generated files.
6. Never approve.
7. Never request changes in v1.
8. Do not duplicate existing comments.
9. Do not comment on formatting handled by linters.
10. Do not execute code.

Default output:

```text
1 PR review summary
0-8 inline comments
```

## 13. Issue triage behavior

The bot posts one concise comment:

```markdown
### AI triage

Likely type: bug
Confidence: medium

Missing information:
- Browser/version
- Steps to reproduce
- Expected vs actual behavior

Suggested labels:
- bug
- frontend
- needs-reproduction
```

Only apply labels if they are allowlisted.

Otherwise just suggest them.

## 14. LLM integration

Use `@ai-sdk/openai-compatible`.

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

export const llm = createOpenAICompatible({
  name: 'internal-llm',
  baseURL: process.env.LLM_BASE_URL!,
  apiKey: process.env.LLM_API_KEY!,
});
```

Use structured output.

Reject invalid output instead of trying to repair everything.

## 15. Config

Start with environment variables:

```text
GITHUB_APP_ID
GITHUB_PRIVATE_KEY
GITHUB_WEBHOOK_SECRET
GITHUB_BOT_LOGIN
LLM_BASE_URL
LLM_API_KEY
LLM_MODEL
DATABASE_URL
ALLOWED_ORGANIZATIONS
```

Do not build repo-level YAML config yet.

Add `.ai-review.yml` only when one repo genuinely needs different behavior.

## 16. Observability

Expose `/metrics`.

Minimum metrics:

```text
webhook_received_total
webhook_rejected_total
jobs_created_total
jobs_completed_total
jobs_failed_total
job_duration_seconds
llm_tokens_total
github_api_errors_total
```

Logs must include:

```text
job_id
delivery_id
repository
issue_number
change_request_number
trigger_actor
job_type
status
duration
```

Do not log full prompts by default.

## 17. Kubernetes

### `ai-review-web`

Needs:

```text
GITHUB_WEBHOOK_SECRET
DATABASE_URL
ALLOWED_ORGANIZATIONS
GITHUB_APP_ID
GITHUB_PRIVATE_KEY
```

Does not need:

```text
LLM_API_KEY
```

### `ai-review-worker`

Needs:

```text
DATABASE_URL
GITHUB_APP_ID
GITHUB_PRIVATE_KEY
LLM_BASE_URL
LLM_API_KEY
LLM_MODEL
```

Network:

```text
web    → Postgres, GitHub API
worker → Postgres, GitHub API, LLM gateway
```

## 18. Acceptance criteria

### Webhook

* Invalid signature returns 401.
* Duplicate delivery does not create duplicate job.
* Unknown repository is ignored.
* Valid command creates one queued job.
* Webhook response is fast and does not wait for LLM.

### Worker

* Worker claims one job.
* Worker retries failed transient jobs.
* Worker marks permanent failures.
* Worker records token usage.
* Worker posts one GitHub result.

### Review

* `@bot review` on a PR posts one review.
* Inline comments are only on changed lines.
* Max inline comment limit is respected.
* Low-confidence findings are dropped.
* Same PR head SHA is not reviewed twice for the same trigger.

### Triage

* `@bot triage` on an issue posts one comment.
* Suggested labels are from allowlist.
* Bot does not spam repeated comments.

## 19. Future GitLab migration rule

Do not build GitLab now.

But avoid these names in core code:

```text
pull_request
github_repository
github_review_job
octokit in domain logic
```

Prefer:

```text
change_request
repository
review_job
provider = 'github'
```

When GitLab becomes real, add:

```text
src/gitlab/*
```

Then extract the smallest shared interface from GitHub + GitLab.

Not before.

## 20. First milestone

Build only this:

```text
@enac-ai-reviewer triage
```

on GitHub issues.

Why?

It avoids inline diff positioning, PR review API quirks, and large diffs.

Success means:

1. webhook works,
2. auth works,
3. queue works,
4. worker works,
5. LLM works,
6. GitHub posting works.

Then add:

```text
@enac-ai-reviewer explain
```

Then only after that:

```text
@enac-ai-reviewer review
```

## Appendix: senior-devops verdict

```text
Good:
  GitHub App now
  Postgres queue
  one image, two commands
  neutral domain names
  GitHub code isolated

Bad:
  full SCM abstraction now
  GitLab adapter now
  Redis before Postgres fails
  dashboard before logs/metrics fail
  PR inline review before issue triage works
```

The laziest safe path is: **issue triage first**. It proves the whole stack without touching the hardest part: inline review comments.
