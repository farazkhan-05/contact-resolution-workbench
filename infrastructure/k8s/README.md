# Kubernetes deployment validation

These manifests validate the existing FastAPI/Celery architecture in an ephemeral
kind cluster. Kubernetes is not the production hosting platform. Contact Resolution Workbench
uses Vercel for React, Northflank for API/Celery/private Redis and Neon PostgreSQL.
Render belongs to the historical POC/rollback record. Latest backend rollout and
public release acceptance remain pending; see the
[final readiness audit](../../docs/final-readiness-audit-2026-10-04.md).
The manifests and kind evidence below validate local/CI behavior, not live hosting.

`base/` defines the API Deployment/Service, worker Deployment and non-secret
ConfigMap. Both Deployments use one locally built backend image with different
commands. `kind/` adds disposable Redis and PostgreSQL, a migration Job, and a
test-only API auth mount. This is a validation setup, not a production database
or Redis hosting design. PostgreSQL uses `emptyDir`; Redis disables persistence.
Both official Docker Library images are pinned by version and digest.

Run from the repository root with Docker running:

```sh
uv sync --frozen --project backend
uv run --frozen --project backend python infrastructure/kind_validate.py
```

The runner downloads official checksum-verified kind v0.33.0 and kubectl v1.37.0
to temporary storage. The node image is the release's official
`kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5`.
See the [kind release](https://github.com/kubernetes-sigs/kind/releases/tag/v0.33.0).
It refuses to replace an existing `crw-e1` cluster and isolates its kubeconfig.
Nothing is pushed to an image registry.

The gate renders Kustomize, performs a client dry-run against the fresh cluster,
builds the existing Dockerfile, checks its non-root UID/GID, and loads that exact
image with `kind load docker-image`. Secrets are generated in memory for this
run only and submitted through stdin; no secret manifest is stored in Git.
Required Secret keys are `postgres-secrets.POSTGRES_PASSWORD` and
`backend-secrets.DATABASE_URL`/`KIND_TEST_TOKEN`. Non-secret broker and telemetry
settings come from `backend-config`.

Redis/PostgreSQL become ready first. A single migration Job runs Alembic and
sets up LangGraph PostgreSQL checkpoints. Only after that Job succeeds does the
runner apply API/worker Deployments, avoiding per-pod migration races. Reusing
this ordering outside the runner is the caller's responsibility.

The API has startup, readiness and liveness probes on the existing `/api/health`.
That endpoint checks process health, not database or broker readiness. The worker
has no Kubernetes probe: Deployment availability alone does not prove it can
process tasks. The gate separately requires a Celery broker ping and successful
durable integration results. Backend containers use the image's UID/GID 999,
disable privilege escalation, drop capabilities and use RuntimeDefault seccomp.
Supporting services also run non-root. No workload needs a service-account token.
CPU/memory requests and limits are modest CI defaults, not production tuning.

The kind-only auth module is mounted from `backend/tests/kind_api.py`, accepts
one generated synthetic bearer token, and is absent from the backend image.
The base API still starts `app.main:app` with ordinary Firebase authentication.
Do not use the kind overlay as a public deployment.

The existing async integration test submits CSV over real HTTP to the API,
then verifies Redis/Celery processing and the durable PostgreSQL Job/Case,
including duplicate delivery and workspace isolation. Selected existing D1
tests verify checkpoint reconstruction, concurrent duplicate execution, and
real worker interrupt/resume. They also exercise the embedded MCP operations
without live Gemini. The test-only `tests.investigate_mcp_fixture` worker task
is excluded here because it is deliberately absent from the backend image;
the ordinary async integration job retains that complete test coverage.
No Firebase network access, AI judge, telemetry backend or production database
is needed.

`.github/workflows/kind.yml` runs this dedicated gate for relevant backend and
infrastructure pushes/PRs, plus manual dispatch. Failure diagnostics include
pods, events, Deployment/Job descriptions and bounded logs with generated values
redacted. The runner deletes the cluster in `finally`; CI also has an `always()`
cleanup step for cancellation. Kubeconfig and generated configuration live in
temporary storage, outside the checkout.

Local verification on 2026-10-01 passed rendering, client dry-run, a fresh kind
deployment, migrations, rollouts, health, four async/D1 tests and cluster cleanup.
The complete Compose integration selection passed five tests. The backend final
gate passed 267 tests with seven skipped, Ruff, formatting and mypy; the frontend
install/lint/TypeScript/build gate also passed. Remote Actions inspection was
unavailable because GitHub CLI was unauthenticated. These are historical E1
results; the [final audit](../../docs/final-audit.md#final-verification) records
the later backend and service gates.

Historical staging used the native Northflank template and Vercel Preview configuration; the portfolio frontend subsequently moved to Vercel Production.
Terraform was evaluated and not adopted; no Terraform state is maintained.
