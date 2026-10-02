# Production portfolio cutover

Released on 2026-10-02. [Open Identity Resolution Workbench](https://contact-resolution.vercel.app). Use synthetic data only. This is a live portfolio deployment with no enterprise availability, scale or safety SLA.

## Git and deployment

The clean starting branch was `productization/v1` at `5c41dedc29908d1622e17cb66b2531442d863067`, matching its remote. Local and remote old `main` were `3bbda287bbe6525164f282a227c14926d6e20cb5`. Annotated tag `v0-poc` was pushed and its target independently verified as that old commit.

Normal non-squash merge `6120e72e71a5cb3709694f11ebcdd7f5d7f303d1` promoted the product with both histories intact. Vercel automatically built Production deployment `dpl_8NswoMQ4kPpvVv5495mej2NNj8hk` from that exact SHA and assigned the production aliases. The documentation update follows as a normal commit on `main`.

GitHub default and Vercel Production Branch remain `main`. Commit to `main`, push, and Vercel automatically deploys the frontend. `productization/v1` is retained until the user confirms the release from their browser. No force push, history rewrite or permanent legacy-production branch was used.

## Reused environment

| Component | Verified live configuration |
| --- | --- |
| Frontend | Vercel project `contact-resolution-workbench`, root `frontend`, Vite, Hobby; primary domain `contact-resolution.vercel.app` |
| Redirect | `contact-resolution-workbench.vercel.app` redirects to the primary domain |
| API | `https://http--staging-api--t686v9g45v9c.code.run`, Northflank `crw-staging` / `staging-api` |
| Worker | Existing private `staging-worker`, Celery, one replica |
| Migration | Existing `staging-migrate`, ordinary `alembic upgrade head` command; successful E4 run retained |
| Runtime secrets | Existing `staging-runtime`; credentials remain provider-managed |
| Redis | Existing project-private `staging-redis`, 7.2.16, one replica, no public access |
| Database | Neon project `proud-poetry-67237670`, branch `productization-staging` (`br-lingering-king-b3d5wl98`), database `workbench_staging` |
| Database mapping | Official Neon endpoint read matched Northflank's runtime host to `ep-spring-recipe-b3uhsv9x` on that exact branch |
| Authentication | Verified Firebase project `contact-resolution-staging`, anonymous demo enabled |
| Backend image | API, worker and migration use implementation SHA `92165d63ea47f4c0ce83b7dee9e2f62623ed3269`; backend files are identical to the audited productization HEAD |

Internal staging names were retained. No duplicate service, addon, Neon database/project or Firebase project was created. The retained Preview now shares this portfolio environment and data; it is not a separate production-isolation boundary. The old POC Neon branch and Firebase project remain separate and unchanged.

Before merging, the five working branch-scoped Preview variables were copied into Production through authenticated official Vercel tooling: `VITE_API_BASE_URL`, `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`. Values stayed in memory, and read-back verified equality. Preview overrides were preserved. The old API variable was retained as the Preview-wide fallback, with Production moved to a separate verified configuration.

Only `https://contact-resolution.vercel.app` was added to API CORS and only `contact-resolution.vercel.app` was added to Firebase Authorized Domains. Existing verified domains were preserved. Production and Preview preflights returned 200 with their exact allow-origin value and credentials support. An unrelated origin returned 400 without an allow-origin header. No wildcard CORS was introduced; read-back confirmed no other effective API runtime value changed.

## Acceptance

Pre-cutover health returned 200; Firebase bootstrap, Source authority, HTTP idempotency/conflict, a completed REFERENCE Job, rotation, disable and retained history passed. Read-only checks confirmed current Alembic head `e4a1b2c3d4e5`, private Redis ping and Northflank Celery ping.

Two real Chromium tests passed against the production URL in 1.7 minutes, adapting the existing acceptance suite without changing application code. Tokens and Source keys stayed in memory; traces, videos, screenshots and auth snapshots were disabled.

| Production check | Result |
| --- | --- |
| Application / JS / CSS / auth / bootstrap / Cases / Sources | Passed; legitimate anonymous Firebase sessions |
| REFERENCE Source / tiny batch | Three reference records persisted; ingestion `f3795989-e60a-4ffa-b64d-a47a27e8194b`, Job `30ae51d0-5be8-49a3-87c7-bc7df117c4fb`, SUCCEEDED |
| INCOMING Source / tiny batch | Three Cases created; ingestion `3bf968a6-12a0-4d84-ad2f-c47aca325978`, Job `d683c6ed-c1e3-4b8d-9d6b-911ac32bbf36`, SUCCEEDED |
| Full processing path | Source-authenticated HTTP → durable Job → private Redis → Northflank Celery → Neon → workspace references → deterministic resolution → Case/review frontend |
| Candidate / provenance | Avery Meridian routed LIKELY_MATCH through WORKSPACE_REFERENCE; Case `11848f74-6a1c-46c2-b01d-c05c0e5891ed`; source, ingestion and external record provenance visible |
| Same key and body | Original ingestion and Job reused; initial Case count stayed three |
| Changed body with same key | HTTP 409 |
| Credential rotation | Old key HTTP 401; new key HTTP 202 and a deliberately new three-row batch completed |
| Disable / history | New ingestion HTTP 401; two completed incoming receipts retained |
| Workspace isolation | Foreign Source, rotation and Case access HTTP 404; mismatched membership HTTP 403 |
| CSV / human review | Job `c0854fd0-7ee9-4bcc-80b9-6d3d7b204b64` observed RUNNING → SUCCEEDED; Case `e28244ca-4175-4587-863a-7de6311ff1ff`; NEED_MORE_EVIDENCE persisted after reload |
| Existing data | All 19 prior Case IDs remain; 26 Cases after seven deliberate synthetic additions |
| Backend / queue / database | Post-acceptance Redis and worker pings passed; three Source Jobs each SUCCEEDED with three rows; Alembic head unchanged |

The production browser observed every application API request using the Northflank origin. Production JavaScript `/assets/index-D5AoefbV.js` embeds that origin and the verified Firebase project, contains no `onrender.com` URL, and passed credential-marker checks. JS/CSS returned 200. Northflank's API and Celery worker retain the same verified image. This proves the live frontend/backend cutover from Render.

One preflight attempt overlapped the CORS-triggered API restart. A later synthetic Source Job failed with WORKER_ERROR before its durable claim (`started_at` was null). Rollback-only processing succeeded. Restarting only the existing worker was followed by a completed fresh preflight and both production browser flows. Root cause remains unestablished; these results do not establish a reliability guarantee. The failed Source was disabled and its receipt retained.

Synthetic acceptance data remains for inspection; no ad-hoc SQL deletion was performed. The incoming test Source is disabled and its history remains. Its rotated batch intentionally accounts for three additional Cases. The existing API has no Source/Case deletion workflow.

## Verification, costs and rollback

Eight deployment configuration tests passed, and the frontend built with Production variables injected in memory. Previously passed full frozen gates remain the application-code evidence; no runtime application code, dependency or migration changed during cutover. Documentation receives diff/secret/link checks before its commit.

Final Northflank inventory remains two services, one migration job, one private Redis addon and one secret group, with unchanged plans/replicas. Twenty available hourly usage entries all reported USD 0; no finalized invoices were listed. Developer Sandbox entitlement remains the previously dashboard-verified account configuration: the team-scoped token cannot independently read the organisation-only plan endpoint. No plan change or paid resource was introduced. Vercel's authenticated team response confirms active Hobby. These are observed facts, not a permanent free-hosting guarantee.

Render was inspected read-only and `/api/health` returned 200. It remains temporary rollback insurance and is no longer the live product backend. Old Vercel deployment `dpl_3mzwZSGUXHFQXP4WY9tLQdZcgZZp` remains available. Prefer restoring that deployment/production alias first if a serious regression appears; restore the old frontend-to-Render configuration only if necessary. Its previous API variable remains retained under Preview scope. Keep `main` history intact; use a normal revert if a code rollback becomes necessary. Do not delete the Northflank environment during rollback.

GitHub CLI remains unauthenticated, so remote Actions is unverified. Git transport verified remote refs and default `main`; no authentication bypass was used. User browser confirmation is the remaining step before any later deletion of `productization/v1`.

The documented limitations remain: synthetic benchmarks provide no real-world false-merge guarantee; runtime candidate retrieval caps at 100 blocked records; hard worker crashes require manual recovery; Gemini embedding performance is unassessed; no live DeepEval judge ran; LangGraph/MCP has local evidence without public execution; Kubernetes was validated with kind rather than used as the live orchestrator.
