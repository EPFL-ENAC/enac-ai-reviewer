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

All v1 job types are implemented and tested: `@enac-ai-reviewer triage` (issues), `explain` and `review` (pull requests), triggered by mention, label, or assignment. Kustomize manifests for the ENAC cluster are drafted under `k8s/`.

Not yet done, and blocking a real deployment:
- No GitHub App has been created in the EPFL-ENAC org yet (webhook URL, permissions, and `GITHUB_APP_ID`/`GITHUB_PRIVATE_KEY`/`GITHUB_WEBHOOK_SECRET` all depend on that).
- No real `LLM_API_KEY` for the RCP AIaS endpoint has been provisioned.
- `k8s/secret-*.yaml` are placeholders — real secret values need a provisioning mechanism (see the TODO comments in those files).
- Not yet exercised against a live GitHub App + real PR/issue traffic.

## Local development

```text
docker compose up -d postgres
cp .env.example .env   # fill in GITHUB_WEBHOOK_SECRET etc.
pnpm install
pnpm run migrate up
pnpm run test
pnpm run dev:web        # or dev:worker
```
