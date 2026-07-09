# Initial Implementation Plan

Companion to [PRD.md](./PRD.md). This is the build order, not a re-statement of requirements. Each phase ends in something runnable and testable; nothing in a later phase blocks an earlier one from shipping.

## Stack decisions (v1)

| Concern | Choice | Rationale |
|---|---|---|
| Runtime | Node.js 22 LTS + TypeScript | Team standard; `@ai-sdk/*` is first-class here |
| Package manager | pnpm | PRD specifies `pnpm start:web` / `pnpm start:worker` |
| Web framework | Fastify | Raw-body access for HMAC validation, fast, tiny |
| GitHub client | `octokit` (`@octokit/app` + `@octokit/rest`) | Confined to `src/github/*` only |
| LLM client | `@ai-sdk/openai-compatible` + `ai` (structured output via Zod schema) | PRD §14 |
| DB access | `postgres` (porsager) — plain SQL, no ORM | The queue is 3 tables; an ORM is overhead |
| Migrations | `node-pg-migrate`, plain SQL files in `src/db/migrations/` | Boring and inspectable |
| Metrics | `prom-client` on `/metrics` | PRD §16 |
| Logging | `pino`, structured JSON | Required log fields from PRD §16 |
| Validation | `zod` (env config, LLM output, webhook payload narrowing) | One schema library everywhere |
| Tests | `vitest` + a Postgres testcontainer (or `docker compose` DB) | Queue semantics need a real Postgres |

## LLM endpoint

The target gateway is **RCP AIaS** (OpenAI-compatible):

```text
LLM_BASE_URL = https://inference.rcp.epfl.ch/v1
LLM_API_KEY  = <bearer token, worker-only secret>
LLM_MODEL    = Qwen/Qwen3.6-35B-A3B   # default; cheap, 262k context
```

Model notes (from the RCP AIaS catalogue, prices per 1M tokens):

- `Qwen/Qwen3.6-35B-A3B` — default for triage/explain: 262k context, cheapest of the large-context options ($0.032 in / $0.097 out).
- `Qwen/Qwen3.5-122B-A10B` or `zai-org/GLM-5.2` — candidates for `review` if the 35B output quality is insufficient (GLM-5.2 has 1M context for huge diffs).
- Model is a single env var in v1; per-job-type models only if triage vs review quality demands it.

## Phase 0 — Scaffolding (repo skeleton)

**Goal: `docker build` succeeds, CI is green on an empty-ish project.**

- pnpm workspace-less single package, TypeScript strict, ESM.
- `src/` layout exactly as PRD §6 (`web/`, `worker/`, `github/`, `llm/`, `db/`, `domain/`).
- `src/domain/types.ts`: `ReviewJob`, `JobType` (`issue_triage | change_request_explain | change_request_review | review_thread_reply`), `JobStatus` (`queued | running | done | failed | dead`), `TriggerCommand`.
- Zod-validated env config module — fails fast at boot; web and worker each validate only the vars they need (PRD §17 secret split).
- Single `Dockerfile` (multi-stage, distroless or alpine runtime), entrypoint switches on `web` / `worker` arg.
- `docker-compose.yml` with Postgres 16 for local dev.
- GitHub Actions: lint (eslint), typecheck, test, docker build.
- Scripts: `pnpm start:web`, `pnpm start:worker`, `pnpm migrate`.

## Phase 1 — Database + queue

**Goal: jobs can be inserted, claimed, retried, and completed — proven by tests against real Postgres.**

- Migration 001: `webhook_deliveries`, `review_jobs`, `llm_usage` exactly as PRD §7, plus index on `review_jobs (status, created_at)`.
- `src/db/jobs.ts`:
  - `insertDelivery()` — returns false on `delivery_id` conflict (dedupe).
  - `enqueueJob()` — `on conflict (dedupe_key) do nothing`.
  - `claimJob()` — `select … for update skip locked` + set `running`/`started_at` in one transaction (PRD §8).
  - `completeJob()`, `failJob()` — failure increments `attempts`; re-queues if `attempts < max_attempts`, else marks `dead` with `error_message`.
- Dedupe key convention (deterministic, no timestamps):
  - triage/explain: `{provider}:{repo}:{type}:{issue_number}:{comment_id-or-label-event-id}`
  - review: `{provider}:{repo}:review:{cr_number}:{head_sha}` — enforces "same head SHA not reviewed twice" (PRD §18).
- Tests: duplicate delivery → one job; two concurrent claimers → no double-claim; retry/dead-letter transitions.

## Phase 2 — Web process (webhook intake)

**Goal: a real GitHub webhook produces exactly one queued job in < 100 ms, and every rejection path returns the right status.**

- Fastify server with raw-body capture on `POST /webhooks/github`.
- Pipeline (PRD §11):
  1. Timing-safe `X-Hub-Signature-256` HMAC check → 401 on mismatch.
  2. `X-GitHub-Delivery` dedupe via `webhook_deliveries` → 200 (already seen).
  3. Repository allowlist (`ALLOWED_REPOSITORIES`, comma-separated env) → 204 ignore.
  4. `src/github/map-event.ts`: translate GitHub event → neutral `TriggerCommand | null`. Handles: `issue_comment.created` (mention commands), `issues.labeled` / `pull_request.labeled` (`ai-triage` / `ai-review`), `issues.assigned` / `pull_request.assigned` (bot user).
  5. Guard: ignore events *authored by* the bot itself (no self-trigger loops).
  6. Enqueue job → 202.
- `/healthz` and `/metrics` (`webhook_received_total`, `webhook_rejected_total`, `jobs_created_total`).
- Tests: replay fixture payloads (recorded from a real App) through the full pipeline; all PRD §18 webhook criteria.

## Phase 3 — Worker loop + GitHub App auth

**Goal: worker claims a job, gets an installation token, and posts a hard-coded comment on a real issue in a sandbox repo.**

- `src/worker/worker.ts`: poll loop (1–2 s interval, jittered), graceful SIGTERM drain, per-job timeout.
- `src/github/auth.ts`: App JWT → installation token, cached until expiry (`@octokit/app` does this).
- `src/github/publish.ts`: `postIssueComment()` first; PR review posting comes in Phase 6.
- Retry classification: GitHub 5xx / rate-limit / network → transient (retry); 4xx auth/permission → permanent (dead).
- Metrics: `jobs_completed_total`, `jobs_failed_total`, `job_duration_seconds`, `github_api_errors_total`.
- **Manual milestone check**: comment `@enac-ai-reviewer triage` on a sandbox issue → bot replies with a placeholder comment. This proves webhook → queue → worker → auth → posting end-to-end before any LLM is involved.

## Phase 4 — LLM integration + issue triage  ← **PRD milestone 1**

**Goal: `@enac-ai-reviewer triage` posts a real AI triage comment (PRD §13 format).**

- `src/llm/client.ts`: `createOpenAICompatible` against RCP AIaS (see above).
- `src/llm/triage.ts`: `generateObject` with Zod schema `{ likely_type, confidence, missing_information[], suggested_labels[] }`. Invalid output → job failure (retry), no repair loops (PRD §14).
- `src/github/fetch-context.ts`: issue title, body, labels, last N comments (token-budgeted truncation).
- Anti-spam: before posting, look for an existing bot triage comment on the issue → update it instead of adding a new one.
- Label application only from an allowlisted set (env var, may be empty = suggest-only).
- Record `llm_usage` per call; `llm_tokens_total` metric.
- **Exit criteria = all PRD §18 triage acceptance criteria.**

## Phase 5 — `explain` on pull requests

**Goal: `@enac-ai-reviewer explain` posts one summary comment on a PR.**

- Fetch PR meta + unified diff (`application/vnd.github.diff`), skip lock/generated files (PRD §12.5), truncate to token budget.
- `src/llm/explain.ts` (extends `review.ts` module family): plain structured summary → single issue-comment on the PR.
- Reuses everything from Phase 4 except the prompt and context fetcher. Deliberately still no inline comments.

## Phase 6 — `review` on pull requests (hardest last)

**Goal: `@enac-ai-reviewer review` posts one PR review with ≤ 8 inline comments on changed lines only.**

- Parse diff hunks → valid (file, line, side) anchor set; any LLM finding that doesn't map to an anchor is dropped, not repaired.
- `src/llm/review.ts`: structured output `{ summary, findings: [{ path, line, side, severity, confidence, body }] }`; drop `confidence < threshold`; cap at 8 (PRD §12).
- Skip existing-comment duplicates (fetch current review comments, dedupe by path+line+similarity).
- Post as **one** PR review, event `COMMENT` — never `APPROVE` / `REQUEST_CHANGES` (PRD §12.6–7).
- Head-SHA dedupe already enforced by the Phase 1 dedupe key.
- `review_thread_reply` job type: stub that acknowledges but defers — implement only if requested after v1.

## Phase 7 — Kubernetes deployment

**Goal: running in the ENAC cluster on the allowlisted sandbox repo.**

- Manifests (kustomize, matching existing ENAC-IT conventions): `ai-review-web` (2 replicas), `ai-review-worker` (1 replica), `Service`, `Ingress` for `/webhooks/github` only.
- Two Secrets honoring the PRD §17 split — web pod never mounts `LLM_API_KEY` or `GITHUB_PRIVATE_KEY`.
- NetworkPolicy: web → Postgres only; worker → Postgres + GitHub API + `inference.rcp.epfl.ch`.
- Migration job (init container or pre-deploy Job running `pnpm migrate`).
- Probes: web `/healthz`; worker liveness via a heartbeat file or trivial HTTP port bound to localhost/pod-only.

## GitHub-side setup (parallel to Phase 0–2, mostly clicking)

1. Create GitHub App `enac-ai-reviewer` in the EPFL-ENAC org.
   - Permissions: Issues RW, Pull requests RW, Contents R, Metadata R.
   - Events: `issues`, `issue_comment`, `pull_request`, `pull_request_review_comment`.
   - Webhook URL → the Ingress endpoint; generate webhook secret.
2. Optionally create machine user `enac-ai-reviewer` so the bot is assignable in the GitHub UI (PRD §10). The App remains the identity that posts.
3. Install the App on the sandbox repo only; expand the install + `ALLOWED_REPOSITORIES` together later.

## Sequencing summary

```text
Phase 0  scaffolding            ─┐
GitHub App setup (manual)        ├─ can run in parallel
Phase 1  db + queue             ─┘
Phase 2  webhook intake
Phase 3  worker + auth + posting   ← first end-to-end proof (no LLM)
Phase 4  LLM + triage              ← PRD milestone 1, ship it
Phase 5  explain
Phase 6  review                    ← hardest part, done last on purpose
Phase 7  k8s (draft manifests earlier, finalize here)
```

## Explicitly deferred (per PRD §4 / §19)

GitLab, `ScmProvider` interface, Redis/BullMQ/KEDA, admin API/dashboard, `.ai-review.yml` repo config, RAG/repo indexing, multi-agent flows, auto-anything. Add each only when its absence hurts.
