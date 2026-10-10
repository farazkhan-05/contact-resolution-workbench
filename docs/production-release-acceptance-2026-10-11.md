# Production release acceptance — 10–11 October 2026

This record captures a bounded synthetic acceptance of the October production
rollout. It does not certify unrestricted SaaS readiness or long-term reliability.

## Evidence

| Item | Result and evidence source |
| --- | --- |
| Backend source | The supplied rollout evidence identifies `324e50b` as the backend source commit, and the worker image tag begins `sha-324e50b`. Local Git inspection verifies that `324e50b`, `ed92cc5` and the audited HEAD `97d598b` contain identical backend trees. A documentation-only commit still contains the complete source snapshot. Deployed image attestation is a separate, unverified question. |
| API | Built and deployed through Northflank; successful deployment confirmed by the user, not independently checked in this documentation pass. |
| Worker | Uses the public GHCR image, per the user; reported tag begins `sha-324e50b`, running `1/1` with zero restarts after 13 minutes. Its image digest was not independently verified. |
| Database setup | Earlier migrations and checkpoint setup succeeded, per supplied rollout evidence. |
| AI provenance | A synthetic AI extraction created a durable Case. AI evidence displayed **Unverified**; extracted role appeared as nonscored context; the source note remained after reload. |
| Investigation | User-reported start, pause at WAITING FOR HUMAN and resume to SUCCEEDED: HUMAN REVIEW REQUIRED. |
| Worker memory | No new worker OOM occurred during this bounded test. Observed worker memory was **255.91 MB of 256 MB**. |

The deployment and runtime observations above are user-reported evidence, not
independent live-provider verification. Backend source-tree equality is independently
verified against local Git history. The Northflank API and GHCR worker are separate
builds of the reported shared source revision; their image digests need not match.
Earlier migration/checkpoint success is historical rollout evidence. This document and the related README status update are
repository-verified documentation changes.

## Acceptance boundary and remaining limits

Acceptance covers the reported rollout and this bounded synthetic provenance and
investigation path. It does not establish long-term worker memory stability, and
the worker has no configured health checks. The frontend's exact deployed SHA is
unverified. Separate CSV acceptance and a final reviewer-decision acceptance were
not recorded. Unrestricted SaaS readiness is not established. This test supports
no claim of zero future OOMs or complete operational reliability.
