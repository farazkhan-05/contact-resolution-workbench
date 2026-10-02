# Sources and ongoing ingestion

CSV uploads handle onboarding, one-off imports, and ad-hoc incoming operations.
The current CSV format creates Cases; the benchmark comparison population comes
from synthetic providers. Source API ingestion adds persisted workspace reference
records through the same candidate-provider interface. CSV incoming records and
API incoming records both use that population and the existing deterministic
matcher, contradiction gates, routing, and review workflow. Normalized name,
email, and phone blocking selects up to 100 persisted candidates per incoming
record, ordered by internal ID before scoring. This portfolio limit can omit
even an exact-contact candidate in a crowded block. It bounds returned/scored
candidates, not database scan cost. The separate benchmark's scored top-20
retriever does not validate recall under this database cap. See the
[final candidate-limit analysis](final-audit.md#candidate-limit-conclusion).

A **Reference Source** maintains authoritative/master records. Each external ID
is unique within its workspace and Source. Sending that ID in a new batch updates
its attributes; IDs from another Source remain separate. An update is a complete
record replacement: omitted optional attributes become empty.

An **Incoming Source** sends records requiring resolution. Each accepted batch
creates Cases, including source, ingestion, external ID, and received time.
Separate batches can intentionally submit the same external ID as new events.
Use HTTP idempotency for retries of the same batch.

Workspace owners create Sources, rotate credentials, and enable or disable them
on **Sources / Integrations**. Members can inspect safe status and the latest 50
runs per Source. The page shows received time, Job state, counts, completion,
and safe failure codes; the review queue shows matching results.

## Credentials

Creation and rotation return a high-entropy opaque key once. Copy it into the
sending application's secret storage. The server stores a lookup identifier
and SHA-256 digest, never the plaintext key. Credential responses use
`Cache-Control: no-store`; the frontend holds the key in transient dialog state
until dismissal. Rotation invalidates the old key. Disable rejects ingestion
while preserving history and reference data. Re-enable accepts the current key.

Firebase authentication and `X-Workspace-ID` authorize management endpoints.
Machine ingestion uses its own Bearer credential; its Source determines the
workspace and purpose. Caller-supplied workspace, role, decision, score, or
candidate fields are rejected in the payload.

## Send a batch

```sh
curl -X POST https://http--staging-api--t686v9g45v9c.code.run/api/v1/source-ingestions \
  -H 'Authorization: Bearer <SOURCE_API_KEY>' \
  -H 'Idempotency-Key: example-001' \
  -H 'Content-Type: application/json' \
  -d '{"records":[{"external_record_id":"customer-1842","full_name":"Alex Example","old_email":"alex@example.test","old_phone":"+1 202 555 0123","employer":"Example Company","location":"Example City"}]}'
```

Both purposes share these CSV-derived attributes. `external_record_id` and
`full_name` are required. IDs accept letters, digits, `.`, `_`, `:`, `/`, and `-`
and must start with a letter or digit. Maximums: 100 records, 256 KB JSON,
100 characters per external ID, 255 per name/email/employer/location, and 50
per phone. Empty batches and duplicate external IDs within a batch are rejected.
Only synthetic data belongs in the public staging environment.

The response includes an ingestion ID and its durable Job. Workspace members can
poll `GET /api/v1/jobs/{job_id}` using a Firebase bearer token and `X-Workspace-ID`,
or inspect Source history. The Source key authorizes batch submission only.
A 202 response acknowledges durable receipt; inspect Job status to confirm processing succeeded. Failed
batches roll back all domain writes and expose a safe failure code. A queue
outage is recorded as `BROKER_UNAVAILABLE`; after recovery, submit a new batch
key. An identical retry refers to the original failed Job, rather than silently
starting a second operation.

Idempotency keys are required (1-200 characters) and scoped to a Source.
The server stores a digest of the key and canonical validated payload. Same key
and payload returns the same ingestion and Job; changed payload returns 409.
Record order is part of the payload. Celery separately claims a pending Job
atomically, so duplicate task delivery cannot create duplicate domain writes.
The worker receives only internal Job/workspace IDs. Job state and domain writes
commit together. Accepted batches continue processing if their Source is later
disabled; disabling prevents new submissions.

The existing Job claim model does not reclaim a Job left RUNNING by a hard worker
termination. Early acknowledgement or interrupted publication can also strand
a PENDING Job. Stop and verify all consumers before operator-controlled recovery
of the same durable Job; submitting a new batch key is not a generic safe recovery
procedure. See the [failure windows and recovery runbook](final-audit.md#worker-crash-analysis-and-manual-recovery).
There is no automatic lease/heartbeat/reconciliation service.

Source management audit rows contain actor, event type, Source ID, and timestamp.
Telemetry accepts only mechanism, source purpose, count, operation status, and
existing timing metadata. It exports no records, credentials, or idempotency keys.

FastAPI, Neon, Redis, and the existing Celery worker implement this contract.
Future Salesforce or HubSpot connectors could submit through it; those connectors
are not implemented. No additional cloud resource is required.
