# enac-ai-reviewer

Minimal self-hosted AI review bot for GitHub issues and pull requests.

GitHub webhook → Postgres job queue → worker → OpenAI-compatible LLM (RCP AIaS) → comment/review posted back to GitHub.

One repo, one container image, two commands:

```text
pnpm start:web      # receive GitHub webhook → enqueue Postgres job
pnpm start:worker   # claim Postgres job → call LLM → post back to GitHub
```

## Docs

- [PRD](docs/PRD.md) — what to build (and, just as importantly, what not to build in v1)
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md) — build order, stack decisions, phase-by-phase goals

## Status

Pre-implementation. First milestone: `@enac-ai-reviewer triage` on GitHub issues.
