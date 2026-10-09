# Implementation Plan: Agentic File Requests During PR Review

Give the review agent the capability to request additional files from the repository while it reviews a pull request. When the diff alone is not enough (imported modules, interface definitions, callers, tests), the model asks for specific files, the worker fetches them from GitHub at the PR head SHA, feeds them back into the prompt, and the loop repeats until the model submits its final review or a turn budget is exhausted.

Example behavior:

```text
Turn 1: model sees title/body/diff
        → {"action":"request_files","paths":["src/domain/types.ts"],"reason":"check exported interface"}
Worker: fetches src/domain/types.ts @ head SHA, appends contents, traces the step
Turn 2: model responds
        → {"action":"submit_review","summary":"...","findings":[...]}
Worker: publishes the review exactly as today
```

## 1. Goals

- Add a bounded agent loop (request → fetch → feed back → repeat) to the `change_request_review` job.
- New GitHub fetcher for file contents at a given ref, with per-file and cumulative size budgets.
- Structured-output protocol (discriminated union schema) so it works with any OpenAI-compatible endpoint — no reliance on native tool-calling support.
- Trace every request/fetch so admins can audit exactly what the agent read via the admin UI.
- Keep `explain`, `triage` and (future) `review_thread_reply` unchanged.

## 2. Non-goals

- No native tool-calling (`generateText` + `tools` + `maxSteps`): provider support varies across OpenAI-compatible endpoints; the union-schema loop achieves the same with structured output only. If the endpoint rejects union schemas, a flat-schema fallback is described in §3.
- Read-only access: only `GET /repos/{owner}/{repo}/contents/{path}` at the PR head SHA. No writes, no shell, no arbitrary URLs.
- No agent loop for `explain` or `triage`.
- No user-facing command args (e.g. `--files=`) — the model decides autonomously what to request.
- No caching of fetched files between jobs.

## 3. Agent loop semantics

The single `generateObject` call in `generateReview` becomes a loop over a turn schema — a discriminated union:

```ts
const FilesRequestTurnSchema = z.object({
  action: z.literal('request_files'),
  paths: z.array(z.string()).max(MAX_REQUESTED_FILES_PER_TURN),
  reason: z.string().optional(),
});

const SubmitTurnSchema = z.object({
  action: z.literal('submit_review'),
  summary: z.string(),
  findings: z.array(ReviewFindingSchema).max(20),
});

const ReviewTurnSchema = z.discriminatedUnion('action', [
  FilesRequestTurnSchema,
  SubmitTurnSchema,
]);
```

Loop rules:

1. Build the existing prompt via `buildPrompt`, extended with the file-request protocol section (§8).
2. Call `generateObject` with `ReviewTurnSchema`.
3. `request_files` turn → sanitize + dedupe paths (§4), fetch contents, append an "Additional files" section to the prompt plus notes for files that could not be fetched, emit traces, increment the turn counter, go to 2.
4. `submit_review` turn → return the final `ReviewResult`.
5. Request-turn budget exhausted (`MAX_AGENT_TURNS`) → make one final call with the submit-only schema (`ReviewResultSchema`) so the loop always terminates with a review.
6. A path already provided in a previous turn is not re-fetched; the prompt notes it is already included.
7. When `MAX_AGENT_TOTAL_FILE_CHARS` is exhausted, further requests are answered in the prompt with "file budget exhausted" and no fetch is performed.

Provider fallback: if the endpoint fails on the discriminated union, switch to a single flat schema (`request_files?: string[]`, `summary?`, `findings?`) and branch on which fields are present; the final review is then re-validated against `ReviewResultSchema`. Decide after the first live run.

## 4. File fetching

New in `src/github/fetch-context.ts`:

- `sanitizeRequestedPaths(paths: string[]): string[]` — pure function; rejects empty strings, absolute paths (leading `/`), `..` segments, backslashes; strips a leading `./`. Deduplicates. (The contents API is already scoped to the repo, but validation prevents junk requests and traversal-style noise.)
- `fetchFileContents(octokit, { owner, repo, ref }, paths): Promise<Map<string, FileFetchResult>>` where `FileFetchResult` is one of:
  - `{ status: 'fetched', content: string }` — truncated to `MAX_AGENT_FILE_CHARS` (or the remaining cumulative budget),
  - `{ status: 'not_found' }` — 404, directory listing, non-file entry or empty file,
  - `{ status: 'binary_skipped' }` — base64 payload does not decode to valid UTF-8 / contains NUL bytes,
  - `{ status: 'too_large' }` — exceeds the per-file budget (or too big for the contents API with bytes on disk),
  - `{ status: 'skipped_generated' }` — matches the existing `GENERATED_FILE_PATTERNS` / `LOCK_FILE_PATTERNS`,
  - `{ status: 'budget_exhausted' }` — cumulative budget spent.
- Loop-level statuses (not from `fetchFileContents`): `duplicate` (already provided in a previous turn) and `invalid` (dropped by `sanitizeRequestedPaths`).
- Skip paths matching the existing `GENERATED_FILE_PATTERNS` / `LOCK_FILE_PATTERNS` (reported as `not_fetched` with a reason).
- Requests are issued at `ref = context.headSha` so the agent always reads the exact code under review.

## 5. Limits

Constants in `fetch-context.ts`, following the existing `MAX_*` style (`MAX_DIFF_CHARS`, etc.):

| Constant                        | Default | Meaning                                        |
|---------------------------------|---------|------------------------------------------------|
| `MAX_AGENT_TURNS`               | 3       | Max `request_files` turns per job              |
| `MAX_REQUESTED_FILES_PER_TURN`  | 5       | Max paths per `request_files` turn             |
| `MAX_AGENT_FILE_CHARS`          | 8 000   | Per-file truncation                            |
| `MAX_AGENT_TOTAL_FILE_CHARS`    | 24 000  | Cumulative file-character budget per job       |

The union schema itself caps `paths` at `MAX_REQUESTED_FILES_PER_TURN`, so oversized requests fail schema validation rather than relying on runtime checks.

## 6. Data flow

```text
runChangeRequestReview (worker)
  fetchChangeRequestContext        → title / body / diff / headSha
  generateReview(model, input, fetchFiles)
    loop:
      generateObject(ReviewTurnSchema, prompt)
      ├─ request_files → sanitizeRequestedPaths → fetchFileContents(@headSha)
      │      → append contents / unavailable notes → trace → next turn
      └─ submit_review → final ReviewResult
    budget exhausted → final generateObject(ReviewResultSchema)
  selectReviewFindings             → unchanged (findings still anchored to diff lines)
  createPullRequestReview          → unchanged
```

`fetchFiles` is a callback injected into `generateReview`, keeping the `llm/` layer free of GitHub imports and the loop unit-testable without octokit. When `fetchFiles` is omitted, `generateReview` keeps today's single-call behavior (plain `ReviewResultSchema`) — backward compatible for any other caller and existing tests.

## 7. Type changes

- `llm/review.ts`:
  - Add `FilesRequestTurn`, `SubmitTurn`, `ReviewTurn` types and the schemas from §3.
  - `ReviewInput` unchanged.
  - `ReviewOutcome` gains `agentTurns: number`, `requestedPaths: string[]`, `fileChars: number`; `inputTokens`/`outputTokens` are summed across all turns.
  - `generateReview(model, input, fetchFiles?)` owns the loop.
- `github/fetch-context.ts`: `sanitizeRequestedPaths`, `fetchFileContents`, `FileFetchResult`, file-size constants (§5).
- `worker/run-job.ts`: `runChangeRequestReview` builds `fetchFiles` (closing over `octokit`, `owner`, `repo`, `headSha`) and an `onEvent` listener, passes both to `generateReview(model, input, fetchFiles?, onEvent?)`, and maps the events to traces (§9).

No database migration: `insertJobTrace` already stores arbitrary JSONB payloads.

## 8. Prompt changes

`buildPrompt` (agent mode only) gains a protocol section:

```text
File request protocol: before submitting your review, you may request up to N additional
files from this repository (at the PR head commit) to make your review more accurate —
e.g. modules imported by changed files, interface definitions, callers, tests.
Respond with {"action":"request_files","paths":["..."],"reason":"..."}.
When ready, or when you have no more useful requests, respond with
{"action":"submit_review","summary":"...","findings":[...]}.
All findings must still reference lines that appear in the diff.
```

Each fetched batch is appended as:

```text
Additional files you requested:
--- src/domain/types.ts ---
<content>
```

plus, when applicable: `These files could not be fetched: [...]` / `Already provided in a previous turn: [...]` / `File budget exhausted; no further files can be provided.`

## 9. Tracing & observability

- `files_requested` (per request turn): paths, reason, turn index.
- `files_fetched` (per request turn): per-path status (`fetched` / `not_found` / `binary_skipped` / `too_large` / `skipped_generated` / `invalid` / `duplicate` / `budget_exhausted`), chars added, cumulative chars.
- Existing `llm_prompt` / `llm_response` traces keep their current post-hoc shape: the final prompt (which contains all appended file sections) and the final result, with token counts summed across turns.

### Admin UI display

The job-detail page (`renderJobDetail` in `src/web/admin/templates.ts`) renders traces generically; every non-`llm_prompt` payload currently falls back to raw JSON. Give the two new trace types first-class rendering in `formatTracePayload` so the file-fetch activity is readable at a glance:

- `files_requested` → turn index, optional reason, and each requested path as a `<code>` chip (same style as the existing `admin-arg` chips).
- `files_fetched` → one row per path with a status badge and character counts, e.g. `src/domain/types.ts — fetched · 1 234 chars`:
  - badge colours via a small `admin-file-status` class family in `src/web/admin/assets/admin.css`, reusing existing CSS variables (`--fg-muted`, `--border`, ...): `fetched` (success/green), `not_found` / `binary_skipped` / `too_large` / `budget_exhausted` (muted), `duplicate` (subtle);
  - one compact table/list per trace event, in chronological order like the other traces.

The JSON API endpoints (`/admin/api/jobs/:id`) already return raw traces — no change needed there.

## 10. Token accounting

`promptTokens` / `completionTokens` are accumulated across every turn; `recordLlmUsage` continues to receive the job totals. `effectiveModel` handling is unchanged (`commandArgs.model` override still applies to every turn).

## 11. Testing

- `src/github/fetch-context.test.ts`:
  - `sanitizeRequestedPaths`: `..`, absolute paths, backslashes, duplicates, leading `./`, empty strings.
  - `fetchFileContents` with a stubbed octokit: 200 base64 text, 404, binary payload, oversize file, generated/lock-file skip.
- New `src/llm/review.test.ts` (fake model + in-memory fetcher):
  - request → fetch → submit flow appends file contents to the prompt,
  - duplicate paths are not re-fetched,
  - unavailable files are noted in the next prompt,
  - budget exhaustion forces the submit-only final call,
  - usage summed across turns; `agentTurns` / `requestedPaths` / `fileChars` reported,
  - `fetchFiles` omitted → single-call behavior identical to today.
- `src/worker/run-job.test.ts`: `runChangeRequestReview` emits `files_requested` / `files_fetched` traces with headSha-derived fetch results.
- `src/web/admin/admin.test.ts`: `formatTracePayload` renders `files_requested` as path chips and `files_fetched` as status rows; all model-controlled strings (paths, reason) are HTML-escaped.
- `npm run typecheck`, `npm run lint`, `npm run test` before finishing.

## 12. Rollout

1. Deploy the worker.
2. The capability is automatic for every `change_request_review` job; tune the §5 constants per release if runs are too eager or too conservative.
3. Audit early runs through the admin UI (job traces: `files_requested` / `files_fetched`) and validate the provider handles the union schema; if not, apply the §3 flat-schema fallback.
