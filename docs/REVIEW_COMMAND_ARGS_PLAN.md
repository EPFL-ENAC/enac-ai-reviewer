# Implementation Plan: Optional Arguments for the `review` Command

Add facultative `EFFORT`, `MODEL`, `CONTEXT` and `PROMPT` arguments to the `@bot review` mention command so users can tune a single review run without changing env vars or repo config.

Example:

```text
@enac-ai-reviewer review --effort=high --model=Qwen/Qwen3.5-122B-A10B --context=backend --prompt="focus on security issues"
```

## 1. Goals

- Parse optional `--key value` / `--key=value` arguments from the mention text.
- Forward those arguments through the webhook → job queue → worker pipeline.
- Apply them only to the `change_request_review` job type.
- Keep all other commands (`explain`, `triage`) unchanged.
- Persist arguments in Postgres so retries use the same settings.

## 2. Non-goals

- No repo-level `.ai-review.yml`.
- No new args for `explain` or `triage` in this change.
- No validation that the requested model exists in the catalogue; the worker will surface an LLM error if it does not.

## 3. Argument semantics

| Argument  | Type                     | Effect |
|-----------|--------------------------|--------|
| `effort`  | `low` \| `medium` \| `high` | Injected into the review prompt to ask for a lighter or deeper review. Defaults to `medium` when omitted. |
| `model`   | string                   | Overrides `LLM_MODEL` for this job only. The worker creates a one-off `LlmModel` instance with the same base URL and API key. |
| `context` | string                   | Free-form context appended to the prompt (e.g. `this is a backend API change`). |
| `prompt`  | string                   | Extra instructions appended to the review prompt (e.g. `focus on security`). |

Unknown arguments are ignored so the parser stays permissive and forward-compatible.

## 4. Parsing rules

- Argument syntax supports both spaced and equals forms: `--effort high` and `--effort=high`.
- Values may be single- or double-quoted to contain spaces: `--prompt "focus on security"`.
- Argument names are case-insensitive; stored values are kept as provided (except `effort` which is normalised to lowercase).
- Arguments may appear in any order after the command word.
- The command word itself is still the first non-whitespace token after the bot mention.

## 5. Data flow

```text
GitHub comment
  ↓
parseMentionCommand(botLogin, body)
  returns { command: 'review', args: { effort, model, context, prompt } }
  ↓
mapWebhookEvent
  adds commandArgs to MappedTrigger
  ↓
github-webhook.ts enqueueJob
  stores commandArgs in the new review_jobs.command_args column
  ↓
worker claims job
  ↓
runChangeRequestReview
  - picks job.commandArgs.model or falls back to ctx.llmModel
  - passes effort/context/prompt to generateReview
  ↓
generateReview
  builds prompt including optional sections
```

## 6. Database change

Add a nullable JSONB column to `review_jobs`:

```sql
alter table review_jobs add column command_args jsonb;
```

This keeps the raw `payload` column untouched and makes per-job settings queryable.

## 7. Type changes

- `domain/commands.ts`: `parseMentionCommand` returns `{ command: TriggerCommand; args: CommandArgs } | null`.
- `domain/types.ts`: add `CommandArgs` interface; add optional `commandArgs` to `ReviewJob` and `NewReviewJob`.
- `github/map-event.ts`: add optional `commandArgs` to `MappedTrigger`.
- `db/jobs.ts`: map `command_args` to `commandArgs` in `ReviewJobRow`, `toReviewJob` and `enqueueJob`.
- `llm/review.ts`: `ReviewInput` grows optional `effort`, `context`, `prompt` fields; `generateReview` accepts an optional model override or the caller passes a different `LlmModel`.

## 8. Prompt changes

`buildPrompt` keeps the existing conservative instructions and appends, when present:

```text
Review effort: high

Additional context:
<user context>

Additional instructions:
<user prompt>
```

## 9. Testing

- Unit tests for the argument parser in `src/domain/commands.test.ts` covering:
  - no args,
  - all four args,
  - quoted values with spaces,
  - equals vs spaced syntax,
  - unknown args ignored,
  - case-insensitive keys.
- Update `src/github/map-event.test.ts` to assert that `commandArgs` is forwarded for mention triggers and absent for label/assignment triggers.
- Run `npm run typecheck`, `npm run lint` and `npm run test` before finishing.

## 10. Migration file

Create `src/db/migrations/<timestamp>_review-command-args.sql` with the `alter table` statement and a matching down migration.

## 11. Rollout

1. Deploy code.
2. Run `npm run migrate up` to add the column.
3. New comments with args start working immediately; old jobs (with `command_args = null`) continue to use defaults.
