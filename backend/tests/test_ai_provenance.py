# ruff: noqa: F811
"""Synthetic-only F11 API, context, privacy and unchanged-scoring regressions."""

import json
import logging
from uuid import uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.orm.attributes import flag_modified

from app import tasks
from app.api import ingest
from app.models.audit import AuditLog
from app.models.case import Case
from app.models.job import Job
from app.models.workspace import Workspace
from app.schemas.resolution import CaseQuery, ExtractedCandidateProfile
from app.services.extractor import GeminiExtractor
from app.services.resolution_service import ResolutionService
from tests.test_jobs import _workspace, jobs_client  # noqa: F401


@pytest.fixture
def ai_case(jobs_client, monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    client, maker = jobs_client
    headers = _workspace(client)
    note = (
        "Claire Reynolds. Her email appears to be claire@demo.example. She may work at Demo Labs."
    )
    monkeypatch.setattr(tasks, "SessionLocal", maker)
    monkeypatch.setattr(
        ingest.ingest_unstructured_job,
        "delay",
        lambda *_: type("R", (), {"id": "synthetic-task"})(),
    )
    monkeypatch.setattr(
        GeminiExtractor,
        "extract_from_unstructured_text",
        lambda *a, **kw: ExtractedCandidateProfile(
            name="Claire Reynolds",
            email="claire@demo.example",
            employer="Demo Labs",
            job_title="Operations Manager",
        ),
    )
    response = client.post(
        "/api/v1/ingest/unstructured",
        headers=headers,
        json={"raw_evidence_text": note, "case_number": "F11"},
    )
    job_id = response.json()["id"]
    tasks.ingest_unstructured_job.run(job_id, headers["X-Workspace-ID"])
    with maker() as db:
        case_id = db.scalar(select(Case.id))
    return client, maker, headers, case_id, job_id, note


def test_success_reload_exact_source_role_privacy_and_duplicate(ai_case, caplog):
    client, maker, headers, case_id, job_id, note = ai_case
    url = f"/api/v1/cases/{case_id}"
    detail = client.get(url, headers=headers).json()
    assert detail["ai_provenance"] == {
        "source_type": "AI_EXTRACTED",
        "job_title": "Operations Manager",
        "unverified": True,
        "source_context_available": True,
    }
    assert detail["review_decision"] == "PENDING"
    assert detail["selected_candidate_id"] is None and detail["reviewed_at"] is None
    response = client.get(url + "/source-context", headers=headers)
    assert response.status_code == 200
    assert response.json()["original_text"] == note
    assert response.json()["job_title"] == "Operations Manager"
    assert set(response.json()) == {
        "source_type",
        "original_text",
        "job_title",
        "created_at",
        "unverified",
    }
    assert "no-store" in response.headers["cache-control"]
    assert note not in json.dumps(detail)
    assert note not in client.get("/api/v1/jobs", headers=headers).text
    assert note not in client.get(f"/api/v1/jobs/{job_id}", headers=headers).text
    assert note not in caplog.text
    tasks.ingest_unstructured_job.run(job_id, headers["X-Workspace-ID"])
    with maker() as db:
        events = db.scalars(select(AuditLog).where(AuditLog.event_type == "CASE_INGESTED")).all()
        assert len(events) == 1
        assert events[0].payload["ai_extraction"]["originating_job_id"] == job_id
        assert all(
            e.field_name != "job_title"
            for c in db.get(Case, case_id).candidates
            for e in c.evidence
        )


@pytest.mark.parametrize(
    "fault",
    [
        "historical",
        "bad_id",
        "bad_role",
        "bad_version",
        "duplicate",
        "foreign_job",
        "wrong_type",
        "failed_job",
        "bad_payload",
        "missing_job",
    ],
)
def test_unavailable_provenance_fails_closed(ai_case, fault, caplog):
    client, maker, headers, case_id, job_id, note = ai_case
    with maker() as db:
        audit = db.scalar(select(AuditLog).where(AuditLog.event_type == "CASE_INGESTED"))
        payload = dict(audit.payload)
        metadata = dict(payload["ai_extraction"])
        job = db.get(Job, job_id)
        if fault == "historical":
            payload.pop("ai_extraction")
        elif fault == "bad_id":
            metadata["originating_job_id"] = [job_id]
        elif fault == "bad_role":
            metadata["extracted_job_title"] = {"unsafe": "metadata"}
        elif fault == "bad_version":
            metadata["version"] = True
        elif fault == "duplicate":
            db.add(
                AuditLog(
                    case_id=case_id, event_type="CASE_INGESTED", actor="system", payload=payload
                )
            )
        elif fault == "foreign_job":
            foreign = Workspace(name="Synthetic foreign workspace")
            db.add(foreign)
            db.flush()
            job.workspace_id = foreign.id
        elif fault == "wrong_type":
            job.job_type = "CSV_INGEST"
        elif fault == "failed_job":
            job.status = "FAILED"
        elif fault == "bad_payload":
            job.payload = "{invalid synthetic payload"
        elif fault == "missing_job":
            metadata["originating_job_id"] = str(uuid4())
        if fault != "historical":
            payload["ai_extraction"] = metadata
        audit.payload = payload
        flag_modified(audit, "payload")
        db.commit()
    response = client.get(f"/api/v1/cases/{case_id}/source-context", headers=headers)
    assert response.status_code == 404
    assert response.json() == {"detail": "Source context unavailable."}
    assert "no-store" in response.headers["cache-control"]
    detail = client.get(f"/api/v1/cases/{case_id}", headers=headers).json()
    assert detail["ai_provenance"]["source_context_available"] is False
    assert detail["ai_provenance"]["job_title"] is None
    assert note not in caplog.text


def test_foreign_case_and_unauthenticated_access(ai_case):
    client, maker, headers, case_id, _, _ = ai_case
    with maker() as db:
        foreign = Workspace(name="Synthetic other workspace")
        db.add(foreign)
        db.flush()
        db.get(Case, case_id).workspace_id = foreign.id
        db.commit()
    assert client.get(f"/api/v1/cases/{case_id}/source-context", headers=headers).status_code == 404
    assert client.get(f"/api/v1/cases/{case_id}/source-context").status_code == 401


@pytest.mark.parametrize(
    "note,fields",
    [
        ("Her email is leyla@demo.example.", {"email": "leyla@demo.example"}),
        ("Her email appears to be leyla@demo.example.", {"email": "leyla@demo.example"}),
        ("She may now work at Demo Labs.", {"employer": "Demo Labs"}),
        ("She might be in İzmir, but Ankara is also mentioned.", {"location": "İzmir"}),
        ("She might be in İzmir, but Ankara is also mentioned.", {"location": None}),
    ],
)
@pytest.mark.parametrize("role", [None, "Operations Manager", "A different role"])
def test_qualifiers_and_role_do_not_change_resolution(jobs_client, monkeypatch, note, fields, role):
    client, maker = jobs_client
    headers = _workspace(client)
    monkeypatch.setattr(tasks, "SessionLocal", maker)
    monkeypatch.setattr(
        ingest.ingest_unstructured_job,
        "delay",
        lambda *_: type("R", (), {"id": "synthetic-task"})(),
    )
    profile = ExtractedCandidateProfile(name="Claire Reynolds", job_title=role, **fields)
    monkeypatch.setattr(GeminiExtractor, "extract_from_unstructured_text", lambda *a, **kw: profile)
    original = "Claire Reynolds. " + note
    job_id = client.post(
        "/api/v1/ingest/unstructured", headers=headers, json={"raw_evidence_text": original}
    ).json()["id"]
    tasks.ingest_unstructured_job.run(job_id, headers["X-Workspace-ID"])
    expected = ResolutionService().resolve(CaseQuery(name=profile.name, **fields))
    with maker() as db:
        case = db.scalar(select(Case))
        assert case.review_decision == "PENDING"
        assert case.routing_status == expected.routing_status.value
        assert sorted(c.total_score for c in case.candidates) == sorted(
            c.total_score for c in expected.candidates
        )
        case_id = case.id
    response = client.get(f"/api/v1/cases/{case_id}/source-context", headers=headers)
    assert response.json()["original_text"] == original
    assert response.json()["job_title"] == role
    assert response.json()["unverified"] is True
