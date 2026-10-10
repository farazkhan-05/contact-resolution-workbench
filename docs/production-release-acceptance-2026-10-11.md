# Production release acceptance — 10–11 October 2026

This record captures a bounded synthetic acceptance of the October production
rollout. It does not certify unrestricted SaaS readiness or long-term reliability.

## Evidence

| Item | Result and evidence source |
| --- | --- |
| Backend source | The supplied rollout evidence identifies `324e50b` as the backend source commit, and the worker image tag begins `sha-324e50b`. In this checkout, `324e50b` is `docs: finalize portfolio documentation` and changes documentation only. The backend source revision is therefore not independently verified from repository history. |
| API | Deployment successful, confirmed by the user; not independently checked in this documentation pass. |
| Worker | User-reported GHCR image tag begins `sha-324e50b`; running `1/1` with zero restarts after 13 minutes. |
| Database setup | Earlier migrations and checkpoint setup succeeded, per supplied rollout evidence. |
| AI provenance | A synthetic AI extraction created a durable Case. AI evidence displayed **Unverified**; extracted role appeared as nonscored context; the source note remained after reload. |
| Investigation | LangGraph reached **WAITING FOR HUMAN**. Investigation completed as **SUCCEEDED: HUMAN REVIEW REQUIRED**. |
| Worker memory | No new worker OOM occurred during this bounded test. Observed worker memory was **255.91 MB of 256 MB**. |

The deployment and runtime observations above are user-reported evidence, not
independent live-provider verification. The source-commit discrepancy is verified
against local Git history. Earlier migration/checkpoint success is historical
rollout evidence. This document and the related README status update are
repository-verified documentation changes.

## Acceptance boundary and remaining limits

Acceptance covers the reported rollout and this bounded synthetic provenance and
investigation path. It does not establish long-term worker memory stability, and
the worker has no configured health checks. The frontend's exact deployed SHA is
unverified. Separate CSV acceptance and a final reviewer-decision acceptance were
not recorded. Unrestricted SaaS readiness is not established. This test supports
no claim of zero future OOMs or complete operational reliability.
