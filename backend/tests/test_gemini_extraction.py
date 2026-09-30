from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.auth import FirebaseIdentity, get_firebase_identity
from app.core.constants import RoutingStatus
from app.core.database import Base, get_db
from app.main import app
from app.models.workspace import User, Workspace, WorkspaceMembership
from app.schemas.resolution import CaseQuery, ExtractedCandidateProfile, RawCandidate
from app.services.contradiction import evaluate_contradictions
from app.services.extractor import GeminiExtractionError, GeminiExtractor
from app.services.fixtures import BENCHMARK_CASES
from app.services.matcher import score_candidate
from app.services.providers import (
    GeminiUnstructuredEvidenceProvider,
    UnstructuredEvidenceRecord,
)
from app.services.resolution_service import ProviderError, ResolutionService


@pytest.fixture
def db_session() -> Session:
    test_engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=test_engine)
    session = Session(bind=test_engine)
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(bind=test_engine)


@pytest.fixture
def client(db_session: Session) -> TestClient:
    def override_get_db() -> Session:
        return db_session

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_firebase_identity] = lambda: FirebaseIdentity(
        uid="gemini-test-user", email="gemini@example.demo", is_anonymous=False
    )
    user = User(firebase_uid="gemini-test-user", email="gemini@example.demo")
    workspace = Workspace(name="Gemini test workspace")
    db_session.add_all([user, workspace])
    db_session.flush()
    db_session.add(WorkspaceMembership(user_id=user.id, workspace_id=workspace.id, role="OWNER"))
    db_session.commit()
    test_client = TestClient(app)
    test_client.headers.update(
        {"Authorization": "Bearer test-token", "X-Workspace-ID": workspace.id}
    )
    yield test_client
    app.dependency_overrides.clear()


# ==============================================================================
# 1. Messy evidence with all/most fields present
# ==============================================================================
def test_messy_evidence_full_extraction() -> None:
    raw_snippet = (
        "Spoke with Claire Reynolds — now at Northstar Analytics as Senior Data Analyst "
        "in Seattle. Best email appears to be claire.reynolds@example.demo; "
        "mobile +1 202-555-0101."
    )

    mock_client = MagicMock()
    mock_response = MagicMock()
    mock_response.text = (
        '{"name": "Claire Reynolds", "email": "claire.reynolds@example.demo", '
        '"phone": "+1 202-555-0101", "employer": "Northstar Analytics", '
        '"job_title": "Senior Data Analyst", "location": "Seattle"}'
    )
    mock_client.models.generate_content.return_value = mock_response

    extractor = GeminiExtractor(client=mock_client)
    extracted = extractor.extract_from_unstructured_text(raw_snippet)

    assert isinstance(extracted, ExtractedCandidateProfile)
    assert extracted.name == "Claire Reynolds"
    assert extracted.email == "claire.reynolds@example.demo"
    assert extracted.phone == "+1 202-555-0101"
    assert extracted.employer == "Northstar Analytics"
    assert extracted.job_title == "Senior Data Analyst"
    assert extracted.location == "Seattle"

    # Verify RawCandidate construction and provenance preservation
    raw_cand = extractor.extract_candidate_from_evidence(
        provider_source="SYNTHETIC_FIELD_NOTES",
        provider_record_id="UNSTRUCT-4001",
        raw_evidence_text=raw_snippet,
        provenance_title="Synthetic Field Notes",
    )
    assert raw_cand.provider_source == "SYNTHETIC_FIELD_NOTES"
    assert raw_cand.provider_record_id == "UNSTRUCT-4001"
    assert raw_cand.name == "Claire Reynolds"
    assert "Structured from provider evidence using Gemini" in raw_cand.provenance_summary
    assert raw_snippet in raw_cand.provenance_summary


# ==============================================================================
# 2. Missing fields remain missing (no hallucination/fabrication)
# ==============================================================================
def test_missing_fields_remain_null() -> None:
    partial_snippet = "Candidate brief: Karen Miller currently consulting at Solaris Labs Inc."

    mock_client = MagicMock()
    mock_response = MagicMock()
    # Model strictly returns nulls for unmentioned fields
    mock_response.text = (
        '{"name": "Karen Miller", "email": null, "phone": null, '
        '"employer": "Solaris Labs Inc", "job_title": "Consultant", "location": null}'
    )
    mock_client.models.generate_content.return_value = mock_response

    extractor = GeminiExtractor(client=mock_client)
    extracted = extractor.extract_from_unstructured_text(partial_snippet)

    assert extracted.name == "Karen Miller"
    assert extracted.employer == "Solaris Labs Inc"
    assert extracted.email is None
    assert extracted.phone is None
    assert extracted.location is None


# ==============================================================================
# 3. Invalid or malformed model extraction is rejected safely
# ==============================================================================
def test_malformed_json_rejected_safely() -> None:
    mock_client = MagicMock()
    mock_response = MagicMock()
    mock_response.text = "NOT_VALID_JSON{bad_content: true"
    mock_client.models.generate_content.return_value = mock_response

    extractor = GeminiExtractor(client=mock_client)
    with pytest.raises(GeminiExtractionError) as exc_info:
        extractor.extract_from_unstructured_text("Some messy text snippet")

    assert "schema validation" in str(exc_info.value).lower()


def test_empty_model_response_rejected_safely() -> None:
    mock_client = MagicMock()
    mock_response = MagicMock()
    mock_response.text = ""
    mock_client.models.generate_content.return_value = mock_response

    extractor = GeminiExtractor(client=mock_client)
    with pytest.raises(GeminiExtractionError) as exc_info:
        extractor.extract_from_unstructured_text("Some text")

    assert "empty response" in str(exc_info.value).lower()


def test_missing_name_in_candidate_extraction_rejected_safely() -> None:
    mock_client = MagicMock()
    mock_response = MagicMock()
    # No name extracted
    mock_response.text = (
        '{"name": null, "email": "test@demo.com", "phone": null, '
        '"employer": null, "job_title": null, "location": null}'
    )
    mock_client.models.generate_content.return_value = mock_response

    extractor = GeminiExtractor(client=mock_client)
    with pytest.raises(GeminiExtractionError) as exc_info:
        extractor.extract_candidate_from_evidence(
            provider_source="SYNTHETIC_SRC",
            provider_record_id="REC-001",
            raw_evidence_text="Just an email test@demo.com with no name",
        )

    assert "did not identify a valid contact name" in str(exc_info.value)


# ==============================================================================
# 4. Gemini/provider failure does not become a false match
# ==============================================================================
def test_gemini_api_failure_raises_provider_error() -> None:
    mock_client = MagicMock()
    mock_client.models.generate_content.side_effect = RuntimeError(
        "Connection timeout to Gemini API"
    )

    extractor = GeminiExtractor(client=mock_client)
    record = UnstructuredEvidenceRecord(
        provider_source="SYNTHETIC_NOTES",
        provider_record_id="FAIL-01",
        raw_evidence_text="Note mentioning Claire Reynolds at some org",
        provenance_title="Notes",
    )
    provider = GeminiUnstructuredEvidenceProvider(
        extractor=extractor,
        fixtures=[record],
    )

    resolver = ResolutionService(providers=[provider])
    query = CaseQuery(name="Claire Reynolds")

    # ResolutionService must fail safely with ProviderError, NOT produce a false candidate
    with pytest.raises(ProviderError) as exc_info:
        resolver.resolve(query)

    assert "Candidate evidence could not be retrieved" in str(exc_info.value)


def test_missing_api_key_fails_safely() -> None:
    extractor = GeminiExtractor(api_key=None, client=None)
    with pytest.raises(GeminiExtractionError) as exc_info:
        extractor.extract_from_unstructured_text("Claire Reynolds at Acme")

    assert "API key is not configured" in str(exc_info.value)


# ==============================================================================
# 5. Extracted candidate proceeds through existing deterministic matcher
# ==============================================================================
def test_extracted_candidate_scored_by_deterministic_matcher() -> None:
    extracted_cand = RawCandidate(
        provider_source="SYNTHETIC_FIELD_NOTES",
        provider_record_id="UNSTRUCT-4001",
        name="Claire Reynolds",
        email="claire.reynolds@acmehealth.demo",
        phone="+1 202-555-0123",
        employer="Acme Health Group Inc",
        job_title="Clinical Director",
        location="Chicago, IL",
        provenance_summary="Structured from provider evidence using Gemini",
    )

    query = CaseQuery(
        name="Claire Reynolds",
        email="claire.reynolds@acmehealth.demo",
        phone="+1 202-555-0123",
        employer="Acme Health Group",
        location="Chicago, IL",
    )

    # Authority: Deterministic Python matching engine
    evidence = score_candidate(query, extracted_cand)
    total_score = sum(e.points_awarded for e in evidence)
    contradictions = evaluate_contradictions(query, extracted_cand)

    assert total_score == 100
    assert len(contradictions) == 0

    # Test resolution with provider
    mock_provider = MagicMock()
    mock_provider.provider_id = "MOCK_AI_PROVIDER"
    mock_provider.search.return_value = [extracted_cand]

    resolver = ResolutionService(providers=[mock_provider])
    resolution = resolver.resolve(query)

    assert resolution.top_score == 100
    assert resolution.routing_status == RoutingStatus.LIKELY_MATCH
    assert len(resolution.candidates) == 1
    assert resolution.candidates[0].candidate.name == "Claire Reynolds"


# ==============================================================================
# 6. Unstructured Ingestion API Endpoint Workflow
# ==============================================================================
def test_unstructured_ingest_api_endpoint(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    mock_client = MagicMock()
    mock_response = MagicMock()
    mock_response.text = (
        '{"name": "David Mitchell", "email": "dmitchell@crestviewlogistics.demo", '
        '"phone": "+1 202-555-0199", "employer": "Crestview Logistics", '
        '"job_title": "Logistics Manager", "location": "Denver, CO"}'
    )
    mock_client.models.generate_content.return_value = mock_response

    # Inject mock into GeminiExtractor
    monkeypatch.setattr(
        "app.services.extractor.GeminiExtractor._get_client",
        lambda self: mock_client,
    )

    payload = {
        "raw_evidence_text": (
            "Recruiter memo: Spoke with David Mitchell regarding supply chain operations. "
            "He is at Crestview Logistics in Denver, CO. Cell +1 202-555-0199."
        ),
        "source_identifier": "MEMO-2025-01",
    }

    res = client.post("/api/v1/ingest/unstructured", json=payload)
    assert res.status_code == 200
    data = res.json()
    assert data["extracted_profile"]["name"] == "David Mitchell"
    assert data["extracted_profile"]["employer"] == "Crestview Logistics"
    assert data["routing_status"] == "LIKELY_MATCH"
    assert data["top_score"] == 75 or data["top_score"] > 50

    # Detail view verification
    case_id = data["case_id"]
    detail_res = client.get(f"/api/v1/cases/{case_id}")
    assert detail_res.status_code == 200
    case_data = detail_res.json()
    assert case_data["raw_name"] == "David Mitchell"
    assert len(case_data["candidates"]) > 0


# ==============================================================================
# 7. Benchmark cases remain 100% unchanged
# ==============================================================================
@pytest.mark.parametrize(
    "case_info",
    BENCHMARK_CASES,
    ids=[str(c["case_number"]) for c in BENCHMARK_CASES],
)
def test_all_benchmark_cases_regression_invariant(case_info: dict[str, object]) -> None:
    resolver = ResolutionService()
    query = case_info["query"]
    assert isinstance(query, CaseQuery)

    resolution = resolver.resolve(query)
    assert resolution.top_score == case_info["expected_top_score"]
    assert resolution.routing_status.value == case_info["expected_route"]
    if resolution.candidates:
        assert (
            resolution.candidates[0].has_serious_contradiction
            == case_info["has_serious_contradiction"]
        )
