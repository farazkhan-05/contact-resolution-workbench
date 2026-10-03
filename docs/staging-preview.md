# Public staging

**Historical evidence:** this dated record does not verify the latest release.
The [4 October final readiness audit](final-readiness-audit-2026-10-04.md) is the
current authority: local engineering and controlled synthetic demos are ready with
limitations; backend provenance rollout, frontend release confirmation and clean
investigation acceptance remain pending.

This is the historical Preview acceptance record. The portfolio frontend moved to [Vercel Production](https://contact-resolution.vercel.app); see [production cutover](production-cutover.md). The Preview remains available, and its Northflank/Neon/Firebase resources now also serve the live portfolio. Internal staging names are retained.

Release validation date: 2026-10-02. This portfolio/staging environment is for synthetic data.
No availability, SLA or scale guarantee is claimed.

**Release gate passed:** `npm ci`, ESLint (including the smoke suite),
TypeScript, Vite build and `npm audit` (zero vulnerabilities). The real public
Chromium smoke passed, observing `RUNNING` → `SUCCEEDED`, case
`fc126e99-924e-448b-993c-f1303e3b35e6`, Job
`8b4c9aeb-74ca-490a-b130-d3c1f603bba4`, persisted review and all boundary checks.
The frontend fix was verified on immutable Preview
`https://contact-resolution-workbench-4c4r9yq3p-farazkhanss-projects.vercel.app`
through its public stable alias. Backend application/configuration code did
not change; backend suites were not repeated.

## Deployment and isolation

| Component | Staging configuration |
| --- | --- |
| Frontend | [Stable staging Preview](https://contact-resolution-workbench-productization-v1.vercel.app) |
| Backend | [Northflank health](https://http--staging-api--t686v9g45v9c.code.run/api/health) |
| Firebase | `contact-resolution-staging`, app `contact-resolution-staging-web` |
| Database | Neon `productization-staging` / `workbench_staging` |
| Queue | Retained project-private Redis 7.2.16 → existing Celery worker |
| Vercel | Existing `contact-resolution-workbench`, root `frontend`, Vite, Hobby |
| Branch | `productization/v1`; production branch remains `main` |

Only Preview variables scoped to `productization/v1` were added:
`VITE_API_BASE_URL`, `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`,
`VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`. The API value is the backend
origin, without `/api/v1`; the client appends endpoint paths. Firebase values
came from the official Firebase Management API using Google authentication and
the staging quota-project header. These are public browser SDK config fields;
Admin service-account credentials remain exclusively on the backend.

The official Google Identity Toolkit admin API added only the stable staging
hostname to staging Authorized Domains, preserving existing entries and auth
settings. Northflank's staging API service has a direct `CORS_ORIGINS` override
for that exact HTTPS origin; comparison confirmed no other effective runtime
value changed. No wildcard frontend origins are allowed.

The stable URL is an explicitly assigned staging alias, rather than a
Vercel-generated Git branch alias. Updating it with `vercel alias set` must
always target a verified Preview deployment. Its public exception persists
when the alias is reassigned. Commit-specific deployment URLs retain normal
Vercel authentication protection and are not CORS-approved frontend origins.

Preview deployments should identify their committed source SHA.

## Browser validation

`@playwright/test` 1.63.0 provides Chromium staging smoke tests for CSV
and Source ingestion. See [Source acceptance](e4-verification.md) for the latter.
There are no API mocks, CAPTCHA workarounds or auth bypasses.
Run explicitly from `frontend`:

```powershell
npm ci
npx playwright install chromium
npm run smoke:staging
```

Normal frontend CI runs no browser installation or staging test. The smoke
creates two anonymous staging Firebase identities in isolated browser contexts
and one uniquely numbered synthetic CSV Case. It uses the repository's
synthetic Claire Reynolds fixture (`.demo` email), never real personal data.
Tokens remain in process memory; no auth storage snapshots, network traces,
videos or screenshots are retained. Synthetic staging users/jobs/cases remain
available for inspection and can be removed through a later staging cleanup.

Checks cover public HTTP 200 and JavaScript assets, staging Firebase sign-in
and workspace bootstrap, HTTP 202 durable Job submission, actual frontend
polling to `SUCCEEDED`, candidate/evidence rendering, a human
`NEED_MORE_EVIDENCE` review with a synthetic note, and persistence after reload.
Boundary checks require 401 without auth or with an invalid token, 404 for a
foreign workspace's Case, 403 for a mismatched membership header, exact-origin
CORS preflight 200 with credentials, and untrusted-origin preflight 400 without
an allow-origin header. Built JavaScript must contain staging endpoints and
exclude Render and Firebase Admin credential markers; all observed application
API requests must use Northflank staging.

An initial CSV attempt returned a generic worker error. A rollback-only
diagnostic successfully reprocessed its synthetic payload; the next browser
attempt completed ingestion. The original transient failure's cause was not
established, and no backend fix or reliability claim is made. Release smoke
also found and fixed a reproducible frontend reload bug: queue requests ran
before Firebase session restoration and were not repeated after bootstrap.
Queue/detail loading now waits for the ready workspace session.

LangGraph/MCP staging execution remains intentionally outside this release
gate: no deterministic staging provider path is configured. Existing local
implementation/integration tests remain the evidence for that feature.

## Rollback and Terraform

During the original Preview release, Production metadata and aliases remained unchanged. The later controlled cutover promoted the finished product to `main` and Vercel Production. Render and the old POC Neon/Firebase environment remain separate rollback resources; annotated tag `v0-poc` preserves old `main`.

To withdraw the Preview later, remove only its alias/public exception and branch-specific Preview configuration. Its backend, database and Firebase project now serve the live portfolio and must not be deleted as Preview cleanup. Production rollback should first restore the prior Vercel deployment; Render remains temporary insurance and is no longer the active backend. Keep `productization/v1` until the user confirms the release from their browser.

Terraform was evaluated and not adopted; no Terraform state is maintained.
Importing the established Vercel project for branch Preview configuration
would add state/drift risk without useful ownership. Northflank retains its
supported native template; no unofficial Neon/Northflank Terraform providers
are introduced.
