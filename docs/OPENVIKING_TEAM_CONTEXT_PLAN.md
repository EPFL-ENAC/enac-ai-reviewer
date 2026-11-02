# Implementation Plan: Team Context From OpenViking (Read-Only)

Give the review agent access to the team's shared OpenViking memory when reviewing a pull request. Before the review prompt is built, the worker runs one semantic search against the account's shared resources (conventions, ADRs, PRDs, sibling repos), and the top hits are injected into the prompt as an explicitly labeled, provenance-carrying "Team context" section. The integration is strictly read-only, fails open, and is fully traced so every review stays auditable.

Example behavior:

```text
@enac-ai-reviewer review --effort=high
Worker: fetchChangeRequestContext        → title / body / diff (unchanged)
Worker: retrieveTeamContext              → 1 semantic search on OpenViking
        hits: [docs/adr-007 "we use node-pg-migrate, no ORM", ...]
        → prompt gains a "Team context" section (abstracts + URIs)
generateReview / selectReviewFindings    → unchanged
createPullRequestReview                  → unchanged
```

If OpenViking is unset, unreachable, slow or returns nothing useful, the review proceeds exactly as today.

## 1. Goals

- Read-only retrieval: exactly one semantic search per `change_request_review` job, against the shared `viking://resources/EPFL-ENAC` tree (configurable).
- Inject only hit *abstracts* (never full document content) into the review prompt, with a per-hit provenance URI and an explicit "verify before relying on it" disclaimer.
- Fail-open: any OpenViking error, timeout or empty result degrades to "no team context" — never fails or delays the review beyond a small deadline.
- Full provenance in job traces: which URIs, which scores, what query — so any review can be explained after the fact.
- New `src/viking/` package, isolated like `src/github/` and `src/llm/` (PRD §2: provider-specific code contained).
- Worker-side only: the web process never talks to OpenViking (same secret split as the LLM, PRD §17).
- Feature is dormant unless `VIKING_BASE_URL` is configured; zero overhead for deployments that do not set it.

## 2. Non-goals

- **No write access.** The bot never writes to OpenViking (no review history, no auto-summaries). Review history already flows into the index via the GitHub repos' daily watches.
- No full-content injection: abstracts only, no content requests. Full documents would bloat the prompt and risk pulling private-repo text into public-repo reviews.
- No changes to `explain`, `triage`, `review_ci_reply` or (future) `review_thread_reply`.
- No agent capability to request *more* memory hits mid-review — the union schema in `llm/review.ts` gains no new action.
- No repo indexing, no watch management, no freshness handling (the existing daily watches cover it).
- No caching of results between jobs (a per-process TTL cache can be added later if latency ever matters).
- No per-user ACL impersonation: the bot's single credential defines the retrieval boundary (§5).

## 3. Retrieval semantics

One search per review job, built deterministically from the review context:

- **Query** = PR title + first 400 chars of the PR body (when present) + up to 15 deduplicated changed file paths extracted from `fullDiff`. Paths — not the diff text — keep the query short and stable.
- **Scope**: `target_uri = VIKING_TARGET_URI` (default `viking://resources/EPFL-ENAC`).
- **Mode**: list-mode retrieval via `POST /api/v1/search/find` — abstracts only, no content ever requested. (Verified against the deployed server: request body `{ query, target_uri, limit, score_threshold }`, response `result.resources[]` with `uri`/`abstract`/`score`.)
- **Filtering**: keep hits with `score >= MIN_TEAM_CONTEXT_SCORE`, cap at `MAX_TEAM_CONTEXT_HITS`, truncate the combined section to `MAX_TEAM_CONTEXT_CHARS`.

Constants in `src/viking/retrieve.ts`, following the existing `MAX_*` style:

| Constant                    | Default | Meaning                                              |
|-----------------------------|---------|------------------------------------------------------|
| `MAX_TEAM_CONTEXT_HITS`     | 5       | Max hits injected into the prompt                     |
| `MIN_TEAM_CONTEXT_SCORE`    | 0.45    | Semantic score floor (server default 0.35 is too loose for injection) |
| `MAX_TEAM_CONTEXT_CHARS`    | 4 000   | Total character budget of the injected section        |
| `MAX_QUERY_PATHS`           | 15      | Changed paths included in the search query            |

## 4. Fail-open behavior

`retrieveTeamContext` returns `{ status, section?, hits }` and **never throws**:

| Status        | When                                            | Effect on review            |
|---------------|-------------------------------------------------|------------------------------|
| `disabled`    | `VIKING_BASE_URL` unset                         | No call at all, no traces    |
| `unavailable` | network error, timeout, non-2xx, bad payload    | Warning logged, review proceeds without context |
| `empty`       | call succeeded, nothing above the score floor   | Review proceeds without context |
| `ok`          | ≥ 1 hit survived filtering                      | `section` injected into the prompt |

The call runs inside the existing job deadline; `VIKING_TIMEOUT_MS` (default 5 000) aborts the fetch. Errors are classified like GitHub errors in `classify-error.ts`: 401/403 → log once at warning with a hint to check `VIKING_API_KEY`; 5xx/network → transient-looking, but still fail-open (no retry in v1 — one shot keeps reviews predictable).

## 5. Confidentiality and scoping

- **The bot's credential is the boundary.** Whatever the `VIKING_API_KEY` can read is what can surface in reviews. The key must therefore be scoped to the resources intended for review context — not the whole account.
- **Repo allowlist**: `VIKING_REVIEW_REPOSITORIES` (comma-separated `owner/repo`, empty = all repos, parsed with the existing `splitAllowlist`). Lets us enable the feature for internal repos only, which removes the "private-repo memory leaks into a public-repo review" direction entirely.
- **Abstracts only** (§2) keeps the leaked-content surface small even when a hit is stale.
- **No echo of URIs into GitHub**: the prompt explicitly forbids the model from mentioning the memory system or its URIs in the posted review.

## 6. Configuration

Worker schema in `src/domain/config.ts` (worker-only env — the web schema is untouched):

| Variable                       | Required        | Default                          | Meaning |
|--------------------------------|-----------------|----------------------------------|---------|
| `VIKING_BASE_URL`              | no              | —                                | Enables the feature when set (e.g. `https://viking.example.org`) |
| `VIKING_API_KEY`               | iff base URL    | —                                | Bearer token |
| `VIKING_TARGET_URI`            | no              | `viking://resources/EPFL-ENAC`   | Retrieval scope root |
| `VIKING_REVIEW_REPOSITORIES`   | no              | empty (= all allowed repos)      | Repo allowlist for the feature |
| `VIKING_TIMEOUT_MS`            | no              | `5000`                           | Retrieval deadline |

- Zod `refine` mirroring the existing Keycloak pattern: `VIKING_API_KEY` is required when `VIKING_BASE_URL` is set, so a half-configured deployment fails at boot, not at review time.
- Reuse `splitAllowlist` for the repo allowlist; expose `vikingReviewRepositories: string[]` on `WorkerConfig` like `allowedOrganizations`.

## 7. Data flow

```text
runChangeRequestReview (worker)
  fetchChangeRequestContext        → title / body / diff / fullDiff / headSha (unchanged)
  extractChangedPaths(fullDiff)    → up to 15 changed paths (new, in github/fetch-context.ts)
  retrieveTeamContext(...)         → 1 OpenViking search, filtered + formatted  (src/viking/)
    ├─ ok        → trace team_context {query, hits[{uri,score}], chars}
    └─ otherwise → trace team_context_skipped {status, reason?}
  generateReview(model, input)     → input.teamContext rendered as its own prompt section
  selectReviewFindings             → unchanged
  createPullRequestReview          → unchanged
```

`generateReview` receives the pre-formatted team context as a plain string (`ReviewInput.teamContext`), exactly like `context`/`prompt` today — the `llm/` layer stays free of OpenViking imports and remains unit-testable without any HTTP client.

## 8. Module and type changes

- **New `src/viking/client.ts`** — thin HTTP client:
  - `vikingSearch(config, request): Promise<VikingHit[]>` — `POST {VIKING_BASE_URL}/api/v1/search/find` with `Authorization: Bearer`, body `{ query, target_uri, limit, score_threshold }`; maps only `uri`, `abstract`, `score` from `result.resources` (verified against the deployed server; a response-shape drift throws and surfaces as `unavailable`, not as garbage injection).
  - Injected `fetch` parameter so tests stub it without a network; `AbortSignal.timeout` enforces `VIKING_TIMEOUT_MS` (default 5 000).
- **New `src/viking/retrieve.ts`**:
  - `extractChangedPaths(diff: string): string[]` lives in `src/github/fetch-context.ts` instead (pure function, reuses the `^diff --git a/(.+?) b/` regex style of `filterDiff`).
  - `retrieveTeamContext({ config, repositoryFullName, title, body, changedPaths }): Promise<TeamContextResult>` — allowlist check, disabled check, query building, one search, filtering, formatting (`section`), and the never-throw contract.
  - `VikingHit = { uri: string; abstract: string; score: number }`; `TeamContextResult = { status: 'ok'|'empty'|'unavailable'|'disabled'; section?: string; hits: VikingHit[] }`.
- **`src/domain/config.ts`** — worker env vars + refine + `vikingReviewRepositories` (§6).
- **`src/llm/review.ts`** — `ReviewInput` gains optional `teamContext?: string`; `buildPrompt` renders it as its own section (§9). Everything else untouched.
- **`src/worker/run-job.ts`** — `runChangeRequestReview` extracts changed paths, calls `retrieveTeamContext`, traces the outcome, and passes `teamContext: team.section` into `generateReview` alongside the existing `context`/`prompt`.

No database migration: `insertJobTrace` already stores arbitrary JSONB payloads.

## 9. Prompt changes

`buildPrompt` appends, when `input.teamContext` is present (before the existing "Additional context" / "Additional instructions" sections, so user-supplied text keeps the last word):

```text
Team context — retrieved from the team's shared knowledge base. These notes may be
stale or unrelated; verify everything against the actual code before relying on it.
Do not mention this knowledge base or its identifiers in your posted review.

- We use node-pg-migrate with plain SQL files; no ORM (viking://resources/EPFL-ENAC/.../adr-007)
- The Helm chart expects `/healthz` on port 3000 (viking://resources/EPFL-ENAC/enac-ai-reviewer/helm)
```

When absent, the prompt is byte-identical to today (backward compatible with existing tests).

## 10. Tracing and observability

- `team_context` (status `ok`): `{ query, hits: [{ uri, score }], chars }` — the audit record of exactly what shaped the review. Abstracts are already visible in the `llm_prompt` trace, so the trace stays lean.
- `team_context_skipped`: `{ status: 'unavailable'|'empty'|'disabled', reason? }`.
- Admin UI: first-class rendering for both trace types in `formatTracePayload` (`src/web/admin/templates.ts`), mirroring the `files_fetched` treatment in the agentic-file-requests plan — each hit as a URI chip + score badge (reuse the `admin-arg` chip / `admin-file-status` badge styles and existing CSS variables). Raw JSON fallback is acceptable for `team_context_skipped`.
- ~~Metric: `viking_retrievals_total{status}`~~ — dropped during implementation: the worker process exposes no `/metrics` endpoint (only the web process does, PRD §5), so a worker-side counter would never be scraped. The `team_context` traces above plus the admin UI are the observability surface.

## 11. Testing

- `src/github/fetch-context.test.ts`: `extractChangedPaths` — multi-file diffs, renames, dedupe, empty diff.
- `src/viking/client.test.ts` (stubbed fetch): 2xx mapping, non-2xx → throws, timeout → throws, malformed payload → throws.
- `src/viking/retrieve.test.ts`:
  - `disabled` when `VIKING_BASE_URL` is unset (and no HTTP call happens),
  - `ok` → bullets contain URI + abstract, sorted/hit-capped as specified,
  - score floor and `MAX_TEAM_CONTEXT_CHARS` truncation,
  - repo allowlist hit and miss,
  - error → `unavailable`, empty hits → `empty`; never throws.
- `src/llm/review.test.ts`: `teamContext` renders the §9 section; omitted → prompt identical to today.
- `src/worker/run-job.test.ts`: review job with a stubbed retriever emits `team_context` with URIs and includes the section in the traced prompt; retriever failure still produces a posted review plus `team_context_skipped`; disabled → no new traces.
- `src/domain/config.test.ts` (or the existing config test home): refine fires when base URL is set without API key; `vikingReviewRepositories` splitting.
- `npm run typecheck`, `npm run lint`, `npm run test` before finishing.

## 12. Rollout

1. Amend the PRD: §4 lists "RAG" as a v1 non-goal — carve out "scoped read-only context retrieval (v2)" explicitly, keeping write-back and full repo indexing as non-goals.
2. Configure `VIKING_BASE_URL` / `VIKING_API_KEY` on the worker deployment (optionally restrict via `VIKING_REVIEW_REPOSITORIES` to internal repos first).
3. Deploy the worker; run a few sandbox reviews and audit the `team_context` traces in the admin UI — check hits are actually relevant and the disclaimer wording holds up in practice.
4. Tune `MIN_TEAM_CONTEXT_SCORE` / `MAX_TEAM_CONTEXT_HITS` per release if runs are too eager or too quiet; promote any constant to an env var only if ops needs it.
5. Only after a few clean weeks, consider extending retrieval to `change_request_explain` (same module, one-line wiring) — deliberately deferred to keep this change reviewable.
