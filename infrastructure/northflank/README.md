# Northflank staging (Milestone E2)

**Status, 2026-10-02: partial staging provisioning; deployment not accepted.**
Northflank authentication and Neon authentication succeeded through their official
CLIs. The user verified Developer Sandbox ($0.00/mo), starting usage $0.00 and an
active payment method in the dashboard. The $50 billing limit is not free credit.
No account upgrade was requested. The billing usage API returned an empty usage
list after provisioning; this is not an independent settled-cost statement.

Northflank project `crw-staging` exists in `europe-west`. Singapore was rejected
with `Region does not support free projects`; Europe West accepted the Sandbox
project. One private Redis addon is running: Redis 7.2.16, `nf-compute-10`, one
replica, 4096 MB mandatory managed-addon storage, no public/VPC access and no TLS.
No API service, worker, migration Job or runtime secret group exists yet.

The first template run (`133157e9-d62d-4a58-be66-62c15c047b85`) created Redis,
then failed with `nfObject not found`: secret restrictions referenced workloads
not yet created. The template now uses project-wide secrets in the dedicated
staging project, whose only intended workloads are API, worker and migration.
The corrected template passed the official native schema locally. Its rerun
(`643f1df7-fa32-4775-a52b-21a2d42fb562`) failed at Redis creation with
`Maximum number of free addons exceeded`. Provisioning stopped at that explicit
Sandbox limit. Do not blindly rerun creation mode or create a second addon;
review native reuse of the retained addon before resuming. The correction has
not yet been exercised through secret-group creation in the account.

Neon organization reports `free`. Workbench project `proud-poetry-67237670` now
has an isolated schema-only branch `productization-staging`
(`br-lingering-king-b3d5wl98`), endpoint `ep-spring-recipe-b3uhsv9x`, fixed 0.25 CU,
and a new empty database `workbench_staging` owned by `neondb_owner`. Free-account
defaults were retained after an explicit suspend-interval override was rejected.
Production branch `br-delicate-flower-b37n5n0u` remains the unchanged default.
No migration was run against either database.

Firebase Admin credentials were verified locally for `contact-resolution-staging`
and supplied only to Northflank's secure template argument overrides, alongside
the staging database URL. Native template ID is `crw-staging`; autorun is disabled.
No credential contents, connection strings or tokens were written to Git.
Migration, HTTPS health, worker readiness and all cloud smoke tests remain unrun.
E1 was pushed to `origin/productization/v1` at
`1378f7ed76f0910ae509c7820d62db26790906dd`. E2 must remain unpushed.

The remaining blocker is the explicit addon-quota rejection on template rerun,
not authentication or payment setup. No paid resource or upgrade may resolve it.

## Architecture and allocation

```text
Explicit staging/test origin -> Northflank HTTPS FastAPI
                                      |          |
                              staging Neon   private Redis
                                      |          |
                                      +--- Celery worker
Same backend image -> one-off Alembic migration Job -> staging Neon only
```

`staging.template.json` is the native Northflank Template IaC source. There is
no Terraform or PostgreSQL addon. The API is a combined build/deploy service,
the worker a deployment service; both use `backend/Dockerfile`'s same build.
The migration Job uses that build too. The source SHA is pinned to pushed E1
in the Build node and both internal image selectors. Update all three selectors
together when intentionally changing the application version.

The sequential workflow creates private Redis and a project-wide runtime secret
group, creates the API at **zero replicas**, builds E1, runs the migration Job
and waits for success, enables one API replica, then creates one worker replica.
CI builds are disabled; migrations do not run at application startup. Creation
mode can attempt to create Redis again and hit the Sandbox addon limit. This workflow is
for initial staging acceptance; review subsequent release changes explicitly.
The service conditions establish platform running state; the smoke establishes
broker/task readiness. No worker HTTP endpoint or HTTP health check is added.

The [official pricing page](https://northflank.com/pricing) advertises always-on
Developer Sandbox allocations of two services, two jobs and one addon. This
template needs **two services, one job, one Redis addon**, plus one secret group.
Northflank [requires a payment method and excludes production use of this tier](https://northflank.com/docs/v1/application/billing/pricing-on-northflank).
These published allowances do not establish eligibility or remaining capacity
for this account. The deployed Redis uses `nf-compute-10`; other workloads have
not been provisioned. Availability
can change; no financial SLA or permanent free hosting is promised.

Redis **7.2.16** is listed by the [official Redis guide](https://northflank.com/docs/v1/application/databases-and-persistence/deploy-databases-on-northflank/deploy-redis-on-northflank).
One replica, no Sentinel/HA, no public or VPC load-balancer access, no backups
or disk autoscaling are requested. The generated private `REDIS_MASTER_URL`
is aliased to `CELERY_BROKER_URL` through the secret group's addon dependency.
TLS is disabled for this project-private staging broker, preserving the existing
Celery `redis://` behavior. `noeviction` prevents silently evicting queued work.
Verify the version and exact connection key are available in the target account
before applying; do not substitute a public URL or a paid plan.

## Configuration

Supply secret values through Northflank's secure **argument overrides**, never
by editing tracked template arguments or storing CLI payloads in Git.

| Category | Setting | Staging value/source |
| --- | --- | --- |
| Account config | `PROJECT_ID` | Dedicated existing Sandbox project `crw-staging` |
| Account config | `SERVICE_PLAN`, `BUILD_PLAN`, `JOB_PLAN`, `REDIS_PLAN`, `REDIS_STORAGE_MB` | Empty until account-visible free eligibility is verified |
| Non-secret | `STAGING_ORIGIN` | One explicit HTTPS Vercel preview/test origin, no wildcard |
| Non-secret | `CORS_ORIGINS` | JSON list containing only that origin |
| Non-secret | `OBSERVABILITY_ENVIRONMENT` | `northflank-staging` |
| Non-secret | `OBSERVABILITY_ENABLED` | `false` |
| Non-secret | `OTEL_SERVICE_NAME` | `contact-resolution-workbench-staging` |
| Non-secret | `HEALTH_PATH`, `API_PORT` | `/api/health`, `8000` |
| Secret | `DATABASE_URL` | Separate staging Neon branch/database URL, SSL required |
| Secret | `CELERY_BROKER_URL` | Generated private addon value; no manually committed URL |
| Secret | `FIREBASE_SERVICE_ACCOUNT_JSON` | Legitimate existing Firebase Admin configuration |
| Optional secret | `GEMINI_API_KEY` | Only for intentional live AI testing; deterministic CSV needs none |

No Langfuse or OTLP endpoints/credentials are set. The application already works
with observability disabled. Firebase ID-token verification is unchanged; there
are no kind test-auth overrides in this deployment. Production Vercel keeps its
current Render API URL. A local HTTP client can test staging without a frontend
deployment; browser tests require the explicit allowed origin above.

## Resume deployment after authentication

1. Authenticate using the official Northflank API, dashboard or
   [CLI](https://northflank.com/docs/v1/api/use-the-cli).
   If needed, the official current stable CLI checked for this milestone is
   `@northflank/cli` 0.13.0 (`npx @northflank/cli@0.13.0`); recheck the stable
   release when resuming. Never retrieve credentials from unrelated stores.
2. Inspect the authenticated account's billing tier, payment activation, remaining
   resource allocations and eligible service/job/build/addon plans (`list plans`
   or the dashboard). Record the **actual plan IDs and zero-charge entitlement**
   for API, worker, migration, Redis storage and build before any resource apply.
   Generic `nf-compute-*` pricing is not proof of free eligibility. If any requested
   resource/allocation is paid or unavailable, stop for review. Use the Sandbox
   project `crw-staging`; do not repurpose a production project.
3. With official authenticated Neon tooling/API, inspect existing branches and
   databases. Reuse a verified separate staging branch/database if present;
   otherwise create a dedicated branch/database. Prefer an empty/schema-only
   branch so production identity data is not copied into this synthetic environment.
   Record project/branch/database and staging endpoint host in deployment notes;
   verify they differ from production. No Neon access means **stop before migrations**.
   Use the staging URL with `sslmode=require`; never fall back to a production URL.
4. Supply the plan inputs, explicit origin, staging database URL and legitimate
   Firebase credential as secure template argument overrides. Connect the GitHub
   repository through official Northflank integration if necessary. Leave Gemini
   empty for the deterministic CSV smoke.
5. Validate locally, import the native JSON through the dashboard's code editor,
   inspect the generated resource specifications and argument resolution, and
   review every billing/network field before running. Northflank performs an
   [authenticated dry-run before executing nodes](https://northflank.com/docs/v1/application/infrastructure-as-code/make-a-template-dynamic).
   This server check has **not run** during E2 preparation. Do not enable autorun
   or run-on-creation to bypass review. Do not serialize resolved secret values
   into tracked JSON or deployment reports.
6. Run the template. Require the build and migration Job to succeed before
   acceptance. Confirm API, migration and worker select the same built E1 SHA/image
   digest; API replicas must remain zero until migration success. Confirm exactly
   two services, one Job, one Redis addon and one secret group, with no public
   worker/Redis ports. Compare the deployed specs to this template, including
   commands, plan IDs, secret links and health probes. Store generated template,
   build, job-run and service DNS identifiers separately from secrets in notes.
7. Check `/api/health` over generated Northflank HTTPS. Inspect worker logs for
   successful private broker connection and readiness; optionally use the
   [official exec command](https://northflank.com/docs/v1/api/execute-command) to
   run `celery -A app.celery_app:celery_app inspect ping --timeout=5` in the worker.
   Never print runtime environment or connection credentials.
8. Run the synthetic smoke below. Retain only redacted pass/fail results and
   synthetic Job/Case IDs. No staging acceptance can be claimed until this passes.

## Local template validation

From `backend`, using the backend environment and an isolated tool dependency:

```powershell
uv run --with jsonschema==4.26.0 python ../infrastructure/northflank/validate_template.py
```

This downloads [Northflank's native JSON Schema](https://api.northflank.com/v1/schemas/template),
validates the complete native template, checks sequential references and empty
secret inputs, and prints the resource inventory and schema SHA256. `--schema`
accepts a previously downloaded official schema for offline repeatability.
The `$schema` editor annotation is removed from the validation payload because
the published payload schema disallows that annotation. Local validation passed
with SHA256 `45a787ea96e384c048e6186dfa6f5ff569c0e7dfcec0240ebfec6b29ece16da0`.
It does not prove free eligibility, actual argument values or cloud execution.

Final local gate: `uv sync --frozen --group ai-evaluation` and the matching pytest
gate passed (**267 passed, 7 skipped**); backend Ruff, format and `mypy app` passed.
Infrastructure Ruff/format and four fail-closed smoke guard tests passed. The
smoke's cloud success path remains unexecuted. No application/container/frontend
files changed, so no Docker rebuild or frontend gate was needed.

## Real synthetic smoke

Use two legitimate Firebase ID tokens for dedicated synthetic test accounts in
separate staging workspaces. Set these environment variables securely, without
including values in shell history or repository files:

```text
STAGING_API_URL             EXPECTED_STAGING_API_HOST
STAGING_DATABASE_URL        EXPECTED_STAGING_NEON_HOST
STAGING_NEON_BRANCH_ID      PRODUCTION_NEON_BRANCH_ID
STAGING_BROKER_URL          STAGING_FIREBASE_TOKEN_A
STAGING_FIREBASE_TOKEN_B
```

First verify the Neon endpoint-to-branch mapping in the authenticated account.
The smoke's explicit host/branch checks are additional guards, not an independent
Neon control-plane attestation. Read-only SQL verifies Alembic heads and Case
persistence; API requests create only a synthetic CSV Job/Case and test workspaces.

Redis remains private. For a local test runner, use the official addon's local
access forwarding command with `--skipHostnames`, bind only loopback, and use the
forwarded local port/password in `STAGING_BROKER_URL`. Never enable addon public
access to run a smoke. Close forwarding after testing.

```powershell
cd backend
uv run --frozen python ../infrastructure/northflank/staging_smoke.py --confirm-staging
```

The script verifies HTTPS health, missing/invalid-token 401, real Firebase
bootstrap, private Redis ping, Celery ping, migration heads, CSV submission,
`SUCCEEDED`, matching Job/Case workspace in Neon, foreign-workspace 403 and
foreign-object 404, then a **completed duplicate delivery** and exactly one Case.
It temporarily enables Celery events to observe duplicate task completion and
restores events to disabled; run on the dedicated staging worker with events
initially disabled and no other event consumers. Tokens, URLs and driver exception
details are not printed. Synthetic records are retained for review, not deleted.

LangGraph/MCP cloud smoke is separate and **pending**. When an intentional
provider/credential path is available, create a synthetic unresolved review case,
start `/api/v1/cases/{id}/investigations`, poll the scoped run, resume a human
interrupt with `STOP`, and confirm `SUCCEEDED`, durable checkpoints and scoped
MCP tool provenance in the staging database. Do not copy kind auth/mocked-provider
injection into staging or claim this CSV smoke validates investigations.

## Deployment record and rollback

| Acceptance item | E2 preparation result |
| --- | --- |
| Native schema / secret-free template / resource inventory | Passed locally |
| Account Sandbox tier / payment activation / actual free plans | Dashboard verified by user; API enforced free addon quota; usage list empty |
| Neon staging branch/database verification or creation | Free organization; isolated branch and empty staging database created |
| Firebase Admin provisioning / synthetic ID tokens | Secure template overrides configured; runtime group and tokens pending |
| Authenticated template dry-run / deployed spec comparison | Two runs failed as documented; retained Redis matches intended private settings |
| Migration / API health / worker / private Redis | Redis running; migration/API/worker not provisioned |
| Async persistence / duplicate delivery / cross-tenant smoke | Script prepared; cloud execution pending |
| LangGraph to MCP investigation | Not run in staging |

Render remains the stable deployment and rollback path. E2 changed no Render
resource, production Vercel API setting or production Neon database. No production
cutover occurred. If a future staging build/migration/smoke fails, record the
failed node/step and sanitized logs, stop staging acceptance, and leave the demo
unchanged. Resume only against the verified staging database; never remediate by
migrating production. Terraform remains deferred to a later infrastructure step
with a mature supported provider, likely Vercel.
