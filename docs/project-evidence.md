# Project evidence

Audited on 2026-10-02, starting at `b12905c` on `productization/v1`. Contact Resolution Workbench has a [portfolio deployment](https://contact-resolution.vercel.app) on `main`. This inventory originally describes 2 October evidence; the [4 October final readiness audit](final-readiness-audit-2026-10-04.md) supersedes its release/verification claims. Local engineering and controlled synthetic demos are ready with limitations; the complete latest public release remains unverified and unrestricted SaaS readiness is not established. [Production cutover](production-cutover.md) records fresh production browser/API acceptance; [final audit and verification](final-audit.md) preserves the engineering gates and constraints.

Statuses describe the evidence available: **IMPLEMENTED** means code exists; **TESTED** means exercised by tests/acceptance; **BENCHMARKED** means measured on the documented dataset; **DEPLOYED** means present in the live portfolio deployment. DEPLOYED entries below refer to retained historical acceptance, not blanket verification of HEAD. Deployment alone does not prove execution of an optional capability.

## Claim inventory

| Claim | Status | Evidence | Caveat |
| --- | --- | --- | --- |
| Firebase authentication | IMPLEMENTED, TESTED, DEPLOYED | [Verification/bootstrap](../backend/app/core/auth.py), [production browser acceptance](production-cutover.md), [final smoke](final-audit.md#final-verification) | Verified project retains its internal staging name |
| Tenant isolation | IMPLEMENTED, TESTED, DEPLOYED | [Workspace tests](../backend/tests/test_workspace_isolation.py), [Source tests](../backend/tests/test_sources.py), [MCP scope tests](../backend/tests/test_investigation_mcp.py) | Membership must authorize the workspace header; not just an object ID |
| Source API | IMPLEMENTED, TESTED, DEPLOYED | [API](../backend/app/api/sources.py), [canonical contract](sources.md), [E4 acceptance](e4-verification.md) | 100 records / 256 KB per batch; no vendor connectors |
| Source credential lifecycle | IMPLEMENTED, TESTED, DEPLOYED | [Generation/digest](../backend/app/services/source_service.py), [rotation/disable tests](../backend/tests/test_sources.py), final authenticated smoke | One-time response/transient UI; accepted work continues after disable |
| HTTP idempotency | IMPLEMENTED, TESTED, DEPLOYED | [Unique Source retry constraint](../backend/app/models/source.py), [receipt transaction](../backend/app/api/sources.py), E4 and final smoke | Same canonical body reuses any Job state, including FAILED; changed body returns 409 |
| Celery duplicate-delivery idempotency | IMPLEMENTED, TESTED, DEPLOYED | [Atomic claims](../backend/app/tasks.py), [real-service tests](../backend/tests/test_async_integration.py), E4 observed completed replay | Duplicate suppression does not provide hard-crash recovery |
| Durable Jobs | IMPLEMENTED, TESTED, DEPLOYED | [Job model](../backend/app/models/job.py), [Job tests](../backend/tests/test_jobs.py), real PostgreSQL/broker suite | PENDING/RUNNING can be stranded; operator recovery documented |
| REFERENCE ingestion | IMPLEMENTED, TESTED, DEPLOYED | [Upsert/provider](../backend/app/services/source_service.py), Source collision/update tests, E4 and final smoke | Unique workspace + Source + external ID; updates replace optional fields; CSV reference importer is not implemented |
| INCOMING ingestion | IMPLEMENTED, TESTED, DEPLOYED | [Shared Case service](../backend/app/services/case_service.py), CSV/Source provider tests, [E4 real batches](e4-verification.md) | New batches intentionally create new events even for the same external ID |
| Ingestion provenance/history | IMPLEMENTED, TESTED, DEPLOYED | [Source/ingestion models](../backend/app/models/source.py), [migration preservation](../backend/tests/test_source_migration.py), E4 UI acceptance | Reference row points to latest update; receipts retain history, not complete previous attribute snapshots |
| Deterministic resolver | IMPLEMENTED, TESTED, DEPLOYED | [Resolver](../backend/app/services/resolution_service.py), matcher/router tests, actual staging Cases | Fixture providers remain synthetic; database cap can omit a true candidate |
| Contradiction gates | IMPLEMENTED, TESTED, BENCHMARKED, DEPLOYED | [Gates](../backend/app/services/contradiction.py), [routing tests](../backend/tests/test_router.py), [C4 gate analysis](../backend/benchmarks/identity_resolution/results/c4/analysis.json) | Jr./Sr. and conflicting full middle names override high scores; no universal identity guarantee |
| Human review | IMPLEMENTED, TESTED, DEPLOYED | [Scoped decisions](../backend/app/api/cases.py), API workflow tests, E3 persisted browser review | Routing outcomes do not silently merge people or submit Accept/Reject |
| Synthetic retrieval/routing benchmark | BENCHMARKED, TESTED | [C1 held-out artifact](../backend/benchmarks/identity_resolution/results/test.json), [C4 held-out artifact](../backend/benchmarks/identity_resolution/results/c4/test.json), final logical reproduction | Synthetic data; separate retrieval implementation from the runtime database provider |
| Rejected semantic/ranking experiments | BENCHMARKED, TESTED | [C2 results](../backend/benchmarks/identity_resolution/results/c2/local-test.json), [C3 selection veto](../backend/benchmarks/identity_resolution/results/c3/selection.json), [methods](identity-resolution-benchmark.md) | MiniLM underperformed; LR/XGBoost gains were artifact-driven; Gemini embeddings unassessed |
| LangGraph investigation | IMPLEMENTED, TESTED | [Graph](../backend/app/services/investigation_graph.py), [real PostgreSQL checkpoints/resume](../backend/tests/test_investigation_integration.py) | Local real-service and earlier production checkpoint restoration verified; clean latest-release acceptance pending; additional retrieval is synthetic |
| Governed MCP v2 | IMPLEMENTED, TESTED | [Official Client/server and mapping](../backend/app/services/investigation_mcp.py), [governance tests](../backend/tests/test_investigation_mcp.py), real-service resume test | Embedded protocol boundary; no public MCP endpoint or arbitrary execution tools |
| OTel privacy/fail-open behavior | IMPLEMENTED, TESTED | [Allowlist/export guard](../backend/app/core/observability.py), [privacy/failure tests](../backend/tests/test_observability.py), Source metadata tests | In-memory/fake exporters; disabled publicly |
| Langfuse integration | IMPLEMENTED, TESTED | Shared provider, v4 processor filtering/masking tests, [investigation documentation](evidence-investigation.md) | No live Langfuse deployment/export claimed |
| DeepEval contracts | IMPLEMENTED, TESTED | [Deterministic artifact](../backend/benchmarks/ai_evaluation/results/deterministic.json), [network-blocking tests](../backend/tests/test_ai_evaluation.py), [method](ai-evaluation.md) | Scripted responses; no live judge, Confident AI login or upload |
| Docker runtime | IMPLEMENTED, TESTED, DEPLOYED | [Dockerfile](../backend/Dockerfile), final build/health/worker ping/UID 999, E4 shared image | Python base is a version tag, not an immutable source digest |
| Kubernetes / kind | IMPLEMENTED, TESTED | [Manifests and runner](../infrastructure/k8s/README.md), [kind CI workflow](../.github/workflows/kind.yml), final static render | Prior kind validation evidence retained; not production-hosted; no fresh kind run because runtime/manifests are unchanged |
| Northflank / private Redis | DEPLOYED, TESTED | [Deployment record](../infrastructure/northflank/README.md), E4 read-back/resource inventory, final health/async smoke | Sandbox constraints; private non-TLS Redis; available historical usage USD 0 is not a future cost guarantee |
| Vercel Production | DEPLOYED, TESTED | [Cutover deployment, bundle and browser evidence](production-cutover.md); [retained Preview record](staging-preview.md) | Production Branch is `main`; Preview remains available |
| Neon environment reuse | DEPLOYED, TESTED | [E4 guarded migration evidence](e4-verification.md), [cutover endpoint mapping and preservation](production-cutover.md) | Verified branch/database retains internal staging names; old POC branch remains separate |
| Production browser end-to-end acceptance | TESTED | [Cutover](production-cutover.md): real Firebase, CSV/review and Source/key/idempotency/isolation flows | Synthetic data only; optional AI/investigation execution is not claimed |

## Defensible evaluation claims

The held-out deterministic retrieval artifact reports Recall@1 **92.91%**, Recall@5 **100%** and Recall@10 **100%** among 127 positive queries. C4 retained thresholds **75/45**: 99 automatic likely matches over 130 queries, **0 unsafe automatic decisions observed in the held-out synthetic benchmark**, 23.85% review/abstention and 6/127 true-match rejections.

The dataset contains 880 synthetic identities, 2,600 records, 880 queries and 1,720 candidate observations across 22 scenarios. Partition integrity keeps linked identities and duplicate feature profiles together. These results do not measure production accuracy, validate the 100-row database cap or guarantee real-world false-merge safety. The [benchmark report](identity-resolution-benchmark.md) preserves denominators and rejection rationale.

MiniLM was evaluated and rejected from runtime retrieval. Logistic Regression and XGBoost reached 97.64% R@1 in the synthetic experiment. Gains materially reflected synthetic missing-field artifacts; both were rejected for production ranking. Neither MiniLM nor pgvector semantic retrieval is a runtime service. Gemini embedding performance remains unassessed. Offline AI evaluation's scripted 1.0 scores are contract regressions, not live Gemini accuracy.

## Ingestion operating model

CSV supports onboarding and ad-hoc incoming imports. REFERENCE Sources populate persistent master data; authenticated INCOMING Sources support ongoing programmatic resolution. A company can start with a batch review and later have its systems submit the same canonical Source contract without changing the resolution/review pipeline.

Salesforce, HubSpot, ERP systems, warehouses and internal applications could integrate by adapting their records to that contract and retaining their own external IDs. Those vendor connectors are an extension model, not implemented integrations. CSV reference loading would also require an adapter or an explicitly added importer; the current CSV endpoint creates incoming Cases.

## Release boundaries and limitations

Synthetic data provides no real-world false-merge guarantee. Gemini embeddings and live DeepEval judging were not run. LangGraph/MCP has earlier production checkpoint restoration evidence, but clean latest-release investigation acceptance is pending. Live OTel/Langfuse export is unverified and public exporters remain disabled. Kubernetes was validated with kind, not live hosting. Candidate retrieval is capped at 100 blocked database rows; hard worker crashes require manual recovery. The live portfolio has Northflank Sandbox constraints and no availability/scale SLA.

One transient initial worker failure was observed during staging deployment. Subsequent complete end-to-end flows passed; root cause was not established. The final audit also records incomplete smoke observations before its successful run without assigning an unsupported cause.

Terraform was evaluated and intentionally not adopted because the currently managed infrastructure does not benefit from adding Terraform state. The controlled production cutover reused the verified environment and retained Render for rollback. One pre-cutover Source Job failed before its durable claim; rollback-only processing succeeded and a fresh smoke passed after restarting the existing worker. The cause remains unestablished. No new cloud resource or paid plan was introduced.

## Latest local engineering and release scope

- Atomic AI finalization commits Case, originating Job provenance and terminal success together; [F06](f06-atomic-finalization-2026-10-03.md) and [latest provenance evidence](f11-ai-provenance-implementation-2026-10-04.md) document local verification. The updated path awaits coordinated API/worker rollout.
- New AI Cases preserve the exact originating Job; authorized reviewers retrieve the retained source note through a scoped API. Extracted role is context only and is not scored. Evidence is unverified, with no invented confidence percentage. Source notes are not unnecessarily duplicated.
- Durable Jobs, HTTP/task idempotency and duplicate-delivery tolerance are bounded guarantees. Publication can be interrupted and hard loss can strand work; there is no universal exactly-once or automatic stale-job recovery guarantee.
- Stale-response protection, human review ownership, tenant isolation and reload/status recovery have current local regression evidence. Earlier production acceptance is retained separately from current frontend release confirmation.
- Optional OpenTelemetry/Langfuse integration is implemented/tested. DeepEval is evaluation-only: 36 authored synthetic cases and scripted contract/governance metrics, not live Gemini accuracy or continuous production validation.
- The latest audit reported five HIGH npm build-chain package entries from one advisory and zero CRITICAL; production-only npm audit found no known advisories. A fresh Python advisory scan was unavailable. The repository is not claimed vulnerability-free.

## Reusable project description

Built a multi-tenant Contact Resolution Workbench using FastAPI, React, PostgreSQL,
Celery/Redis and Gemini, combining deterministic identity safeguards with human
review, AI-assisted evidence extraction, provenance tracking and stateful LangGraph
investigations. Implemented workspace authorization, governed MCP tools, stale-response
protection and optional filtered observability; used synthetic benchmarks to reject
semantic retrieval and learned ranking that did not justify runtime complexity.
Docker runtime, Kubernetes/kind validation and CI workflows support the engineering
portfolio. Latest backend provenance production verification remains pending; no
production traffic or scale claim is made.
