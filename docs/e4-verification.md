# E4 verification record

**Historical evidence:** this dated record does not verify the latest release.
The [4 October final readiness audit](final-readiness-audit-2026-10-04.md) is the
current authority: local engineering and controlled synthetic demos are ready with
limitations; backend provenance rollout, frontend release confirmation and clean
investigation acceptance remain pending.

This is the historical Source milestone acceptance record. That milestone backend subsequently served the [portfolio](https://contact-resolution.vercel.app); later releases are scoped by the current audit above. [Production cutover](production-cutover.md) records fresh Source, CSV, credential and isolation acceptance on the production frontend, with no application-code change.

Verified on 2026-10-02. Starting branch: `productization/v1`, commit
`ee534c18644a3f6b9794cd4107797b49f7526df1`. Application implementation and
staging image: `92165d63ea47f4c0ce83b7dee9e2f62623ed3269`
(`feat: add governed source ingestion`). A subsequent acceptance-only commit
corrects the history-table selector and records these results; runtime code is
identical to the deployed implementation.

See [the Source contract](sources.md) for schema, credentials, idempotency, and
operational limits. Inspection found incoming CSV Case ingestion and synthetic
comparison providers, with no persisted reference importer. E4 adds the
workspace reference provider and reuses the existing matcher and Case services.

## Local gate

- Backend frozen dependency sync, including the existing AI evaluation group:
  **289 passed, 7 skipped**. SQLite and disposable PostgreSQL migration checks
  ran in that gate. Ruff, format check, and mypy passed. Runtime dependency
  audit found no known vulnerabilities.
- Frontend: `npm ci`, lint, TypeScript, and Vite build passed; `npm audit`
  reported zero vulnerabilities.
- Two separate real Redis/Celery integration tests passed. Source reference
  and incoming batches crossed the broker and worker. A specific post-success
  duplicate task emitted `task-succeeded` without additional domain records.
- Shared Docker image built and served API health as non-root UID 999.
- Focused tests cover owner-only management, safe member reads, workspace
  isolation, Source-derived machine authority, invalid/disabled/rotated keys,
  absence of plaintext keys from persistence/audit/logs/telemetry metadata,
  one-time responses, separate Source external-ID namespaces, HTTP retries and
  conflicts, forbidden caller authority fields, atomic rollback, duplicate
  delivery, and CSV matching against the same workspace reference population.
- Both SQLite and PostgreSQL passed upgrade, downgrade, and re-upgrade with
  an existing manual Case preserved. Historical provenance stays nullable.

## Existing staging deployment

Neon control-plane reads independently verified branch `productization-staging`
(`br-lingering-king-b3d5wl98`) and database `workbench_staging`. The migration
workload also checked that its configured database host maps to that branch and
that Firebase configuration names `contact-resolution-staging`.

Northflank build `capable-pan-9726` succeeded. Existing job `staging-migrate`
ran `f6798928-a9d0-426f-ac05-4c2174580e6c` successfully, advancing Alembic to
`e4a1b2c3d4e5`. Before/after Case-ID digests were identical; all seven existing
Cases survived. API and worker deploy the same committed SHA and internal image,
with their existing commands, one replica each, and unchanged plans. The
migration job retains its ordinary `alembic upgrade head` command after the
one-time guarded run.

The [public staging frontend](https://contact-resolution-workbench-productization-v1.vercel.app)
points to ready Preview deployment `dpl_71YCyEnweS4xEZPP4i6pANHU3YPX`. Only the
staging alias changed. No production deployment was requested.

## Public product acceptance

One real Chromium Source acceptance test passed in 1.1 minutes. It used two
legitimate anonymous staging Firebase sessions and synthetic records only.
Credentials remained in process memory; browser traces, videos, screenshots,
and storage snapshots were disabled.

| Check | Result |
| --- | --- |
| Create Reference and Incoming Sources through UI | Passed; one-time keys disappear after dismissal and are absent from later GET and browser storage |
| Reference API ingestion | Three records persisted; run `36b3ce55-4ee5-4353-98d0-fb7c3b5e76df` succeeded |
| Incoming API ingestion | Three Cases created; run `046f1796-5df6-4aa0-97d0-cd9c9c7fe7cb` succeeded |
| Candidate generation and resolution | Workspace reference provider returned candidates; Avery Meridian routed to LIKELY_MATCH |
| Same HTTP key/body retry | Same ingestion and Job; Case count remained three |
| Changed body with same key | HTTP 409 |
| Rotation | Old key HTTP 401; new key accepted and its new batch succeeded |
| Disable | HTTP 401; both completed incoming runs remain visible |
| Cross-workspace Source/Case access | HTTP 404; mismatched membership HTTP 403 |
| Frontend | Sources, counts, history, review queue, and external-ID provenance visible |

The rotated credential submitted a deliberately new batch: two incoming Jobs
and six incoming records in that workspace are expected. A separate staging
Redis/Celery replay observed `task-succeeded` for a specific duplicate of the
first Job (`cdbcedc0-04b4-4d1d-abd1-1ed83ebd086e`); the first ingestion's Case
count stayed **3 -> 3**. Read-only staging queries also confirmed three persisted
reference records and preserved disabled-source history.

Two earlier smoke attempts stopped on an exact-text history selector because
the table cell contains both ingestion and Job IDs. The product operations had
succeeded; correcting the selector completed acceptance. Those attempts retain
synthetic test data in separate test workspaces.

## Resource and production boundaries

Before/after inventory: **two services, one existing migration job, one Redis
addon, one secret group**. No resource or paid feature was added; replica and
plan allocations were retained. Available hourly usage entries all report
**USD 0**, and no invoices are listed. The team-scoped CLI token cannot read the
organisation-only team endpoint; the Developer Sandbox entitlement remains the
previously verified account configuration, with no plan change in E4.

At E4 completion, production Render, Vercel, Neon, Firebase, DNS, and `main` were not modified. The old `main` commit `3bbda287bbe6525164f282a227c14926d6e20cb5` is now preserved by annotated tag `v0-poc`; the subsequent production cutover promoted the finished product with a normal merge commit.
The subsequent [engineering audit](final-audit.md) records the final gates and
remaining reliability and retrieval limitations.
