# enac-ai-reviewer

Minimal self-hosted AI review bot for GitHub issues and pull requests.

GitHub webhook → Postgres job queue → worker → OpenAI-compatible LLM (RCP AIaS) → comment/review posted back to GitHub.

One repo, one container image, two commands:

```text
npm run start:web      # receive GitHub webhook → enqueue Postgres job
npm run start:worker   # claim Postgres job → call LLM → post back to GitHub
```

## Docs

- [PRD](docs/PRD.md) — what to build (and, just as importantly, what not to build in v1)
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md) — build order, stack decisions, phase-by-phase goals

## Status

All v1 job types are implemented and tested: `@enac-ai-reviewer triage` (issues), `explain` and `review` (pull requests), triggered by mention, label, or assignment.

## Deployment

CI/CD follows the same pattern as [co2-calculator](https://github.com/EPFL-ENAC/co2-calculator): `.github/workflows/publish_chart.yaml` packages and pushes `helm/` to `oci://ghcr.io/epfl-enac/enac-ai-reviewer/helm`, then `.github/workflows/deploy.yml` calls [epfl-enac-build-push-deploy-action](https://github.com/EPFL-ENAC/epfl-enac-build-push-deploy-action)'s reusable `deploy.yml` to build/push the image and dispatch an `update-manifest` event to the GitOps repo (`EPFL-ENAC/enack8s-app-config`), which ArgoCD then picks up.

Not yet done, and blocking a real deployment:
- No GitHub App has been created in the EPFL-ENAC org yet (webhook URL, permissions, and `GITHUB_APP_ID`/`GITHUB_PRIVATE_KEY`/`GITHUB_WEBHOOK_SECRET` all depend on that).
- No real `LLM_API_KEY` for the RCP AIaS endpoint has been provisioned.
- `helm/values.yaml`'s `existingSecret.name` fields and `database.existingSecret.name` are placeholders — real Secrets need to exist in the target namespace before first install (same `existingSecret` pattern as co2-calculator).
- The `ORG: enac-it` input in `deploy.yml` and the matching `helm/values.yaml` `image.repository` are a reasonable guess at the ghcr.io namespace, not a confirmed team convention — adjust both together if wrong.
- `CD_TOKEN` must be available as a secret to this repo (org-level in EPFL-ENAC, or added per-repo) for the manifest-repo dispatch step to authenticate.
- A folder for `enac-ai-reviewer` needs to be added to `enack8s-app-config` (or wherever it's GitOps-managed) so the dispatched `update-manifest` event has something to update.
- Not yet exercised against a live GitHub App + real PR/issue traffic.

## Known dependency advisories

`npm audit` flags two things not fixed here, both investigated rather than blind-force-upgraded:
- `@ai-sdk/provider-utils` (transitive, via `ai`/`@ai-sdk/openai-compatible`): an uncontrolled-resource-consumption advisory whose only fix is `ai@7` — a breaking major-version change to the SDK surface this code calls (`generateObject`'s `usage` field names changed, among other things). Not upgraded blind since there's no real `LLM_API_KEY` here to verify the new SDK still works against RCP AIaS; do this deliberately once that's available.
- `esbuild`/`vite`/`vitest` chain (devDependency-only, via `tsx`/`vitest`): a dev-server CORS advisory that only matters if `esbuild serve`/`vite dev` is exposed — neither is used here (vitest uses esbuild for transpilation only, no server). No production exposure; low priority.

## Local development

```text
docker compose up -d postgres
cp .env.example .env   # fill in GITHUB_WEBHOOK_SECRET etc.
npm install
npm run migrate up
npm run test
npm run dev:web        # or dev:worker
```
