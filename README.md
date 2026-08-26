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
- The `ORG: epfl-enac` input in `deploy.yml` and the matching `helm/values.yaml` `image.repository` (`ghcr.io/epfl-enac/epfl-enac/enac-ai-reviewer`) are configured for the EPFL-ENAC GitHub organization; adjust both together if the namespace convention changes.
- `CD_TOKEN` must be available as a secret to this repo (org-level in EPFL-ENAC, or added per-repo) for the manifest-repo dispatch step to authenticate.
- A folder for `enac-ai-reviewer` needs to be added to `enack8s-app-config` (or wherever it's GitOps-managed) so the dispatched `update-manifest` event has something to update.
- Not yet exercised against a live GitHub App + real PR/issue traffic.

### Admin UI ingress

The Helm chart exposes `/admin` through a separate Ingress (`ingress.admin`) so it can be protected by an authentication proxy when running in proxy mode, while `/webhooks/github` remains publicly reachable. In direct Keycloak mode no auth proxy annotations are needed on the ingress.

In your environment-specific values (e.g. `enack8s-app-config`), set the auth proxy annotations when using proxy mode:

```yaml
ingress:
  host: "enac-ai-reviewer.epfl.ch"
  admin:
    enabled: true
    annotations:
      nginx.ingress.kubernetes.io/auth-url: "http://oauth2-proxy.auth.svc.cluster.local/oauth2/auth"
      nginx.ingress.kubernetes.io/auth-signin: "https://auth.example.com/oauth2/start?rd=$escaped_request_uri"
```

The app expects the proxy to pass the authenticated user in `X-Auth-Request-User` (configurable via `web.env.ADMIN_AUTH_HEADER_USER`). `TRUST_PROXY` is enabled by default in the chart because the web pod is always accessed through an ingress/reverse proxy.

### Database

By default the Helm chart deploys an embedded PostgreSQL instance (`database.postgresql.enabled=true`). This is suitable for small deployments.

For the embedded Postgres you can either provide the password directly in values (simple, but stores a secret in Git) or pull it from an existing Secret managed by Infisical/external-secrets:

```yaml
# Option A: password from values (not recommended for production)
database:
  postgresql:
    enabled: true
    auth:
      password: "change-me"

# Option B: password from an existing Secret (recommended)
# The existing Secret must contain:
#   - POSTGRES_PASSWORD: the raw password for the Postgres container
#   - DATABASE_URL: the full connection string for the app
database:
  postgresql:
    enabled: true
  existingSecret:
    name: "enac-ai-reviewer-secret"
    keys:
      password: POSTGRES_PASSWORD
      url: DATABASE_URL
```

For larger or shared deployments, disable the embedded Postgres and provide your own Secret:

```yaml
database:
  postgresql:
    enabled: false
  existingSecret:
    name: "enac-ai-reviewer-db"
    keys:
      url: DATABASE_URL
```

## Admin UI

The web process exposes a read-only admin dashboard at `/admin`:

- `/admin/jobs` — list of all review jobs with status filters and pagination
- `/admin/jobs/:id` — job details and a chronological trace of every step (context fetched, LLM prompt/response, findings filtered, GitHub action taken, errors, etc.)
- `/admin/api/jobs` and `/admin/api/jobs/:id` — JSON endpoints for the same data

The UI auto-refreshes every 10 seconds. Each job can also be **cancelled** (marked dead) or **retried** (re-queued) directly from the list or detail page.

### Authentication

The admin UI supports two authentication modes, selected with `ADMIN_AUTH_MODE`.

#### Proxy mode (`ADMIN_AUTH_MODE=proxy`)

The app is placed behind an organisation authentication proxy (e.g., OAuth2 Proxy). The proxy passes the authenticated user in HTTP headers:

```text
ADMIN_AUTH_ENABLED=true
ADMIN_AUTH_MODE=proxy
ADMIN_AUTH_HEADER_USER=X-Auth-Request-User
ADMIN_AUTH_HEADER_EMAIL=X-Auth-Request-Email
ADMIN_AUTH_USERS=              # optional comma-separated allowlist
TRUST_PROXY=true               # required when running behind a reverse proxy
```

If the configured user header is missing, the admin routes return `401`.

#### Direct Keycloak OIDC (`ADMIN_AUTH_MODE=keycloak`)

The app performs the OIDC authorization-code flow directly with Keycloak, using encrypted browser sessions:

```text
ADMIN_AUTH_ENABLED=true
ADMIN_AUTH_MODE=keycloak
KEYCLOAK_URL=https://keycloak.example.com
KEYCLOAK_REALM=my-realm
KEYCLOAK_CLIENT_ID=enac-ai-reviewer
KEYCLOAK_CLIENT_SECRET=...
KEYCLOAK_REDIRECT_URI=https://enac-ai-reviewer.epfl.ch/admin/auth/callback
SESSION_SECRET=...             # at least 32 characters
ADMIN_AUTH_USERS=              # optional comma-separated allowlist
TRUST_PROXY=true               # required when running behind a reverse proxy
```

When a user visits `/admin` without a session, they are redirected to `/admin/login` and then to Keycloak. After authentication, Keycloak redirects back to `/admin/auth/callback`, the app creates a session, and the user is sent to the originally requested page. A "Log out" link clears the session and redirects to Keycloak's logout endpoint.

For local development without authentication, set `ADMIN_AUTH_ENABLED=false`.

## Known dependency advisories

`npm audit` flags two things not fixed here, both investigated rather than blind-force-upgraded:
- `@ai-sdk/provider-utils` (transitive, via `ai`/`@ai-sdk/openai-compatible`): an uncontrolled-resource-consumption advisory whose only fix is `ai@7` — a breaking major-version change to the SDK surface this code calls (`generateObject`'s `usage` field names changed, among other things). Not upgraded blind since there's no real `LLM_API_KEY` here to verify the new SDK still works against RCP AIaS; do this deliberately once that's available.
- `esbuild`/`vite`/`vitest` chain (devDependency-only, via `tsx`/`vitest`): a dev-server CORS advisory that only matters if `esbuild serve`/`vite dev` is exposed — neither is used here (vitest uses esbuild for transpilation only, no server). No production exposure; low priority.

## Local development

```text
docker compose up -d postgres
cp .env.example .env   # fill in GITHUB_WEBHOOK_SECRET, GITHUB_APP_ID, GITHUB_PRIVATE_KEY, etc.
npm install
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres
npm run migrate up
npm run test
npm run dev:web        # or dev:worker
```

The bot authorizes by **organization**, not by repository: set `ALLOWED_ORGANIZATIONS` to a comma-separated list of GitHub org logins (e.g. `EPFL-ENAC`). The repository must belong to one of those orgs, and the user who triggers the bot must be a member of that org. The GitHub App needs the **Organization members** permission (`members:read`) for the membership check.

To create a tunnel to receive GitHub webhooks on localhost, use [smee](https://smee.io/).
go to smee's website to create a new channel, then run:

```text
npm install --global smee-client
smee --url https://smee.io/<your-smee-channel> --target http://localhost:3000/webhooks/github
```

Update the app on github to use the smee channel URL as the webhook URL, and you should see webhook events arrive in your local dev server.
