import pytest
from sqlalchemy import create_engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app.core.constants import ReviewDecision, RoutingStatus
from app.core.database import Base
from app.models.audit import AuditLog
from app.models.case import CandidateRecord, Case, Contradiction, MatchEvidence
from app.models.workspace import Workspace


@pytest.fixture
def test_db_session() -> Session:
    test_engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(test_engine)
    TestingSessionLocal = sessionmaker(bind=test_engine, expire_on_commit=False)
    session = TestingSessionLocal()
    try:
        yield session
    finally:
        session.close()


def test_case_model_defaults_and_relationships(test_db_session: Session) -> None:
    workspace = Workspace(name="Model test workspace")
    test_db_session.add(workspace)
    test_db_session.flush()
    case = Case(
        workspace_id=workspace.id,
        case_number="CASE-TEST-100",
        raw_name="Jane Doe",
        normalized_name="jane doe",
        raw_email="jane.doe@example.demo",
        normalized_email="jane.doe@example.demo",
    )
    test_db_session.add(case)
    test_db_session.commit()
    test_db_session.refresh(case)

    assert case.id is not None
    assert case.routing_status == RoutingStatus.NEEDS_REVIEW.value
    assert case.review_decision == ReviewDecision.PENDING.value
    assert case.created_at is not None

    # Add candidate
    candidate = CandidateRecord(
        case_id=case.id,
        provider_source="CRM_ARCHIVE",
        provider_record_id="CRM-001",
        name="Jane Doe",
        email="jane.doe@example.demo",
        total_score=85,
        name_score=30,
        email_score=25,
        employer_score=10,
        location_score=10,
        has_serious_contradiction=False,
        provenance_summary="Synthetic CRM fixture",
    )
    test_db_session.add(candidate)
    test_db_session.commit()
    test_db_session.refresh(candidate)

    # Add evidence and contradiction
    evidence = MatchEvidence(
        candidate_id=candidate.id,
        field_name="name",
        source_value="Jane Doe",
        candidate_value="Jane Doe",
        points_awarded=30,
        max_points=30,
        match_method="EXACT_MATCH",
        explanation="Exact normalized full name match",
    )
    contradiction = Contradiction(
        candidate_id=candidate.id,
        contradiction_type="DIFFERING_EMPLOYER",
        severity="MODERATE",
        description="Employer differs from original record",
        blocks_likely_match=False,
    )
    audit = AuditLog(
        case_id=case.id,
        event_type="CASE_INGESTED",
        actor="system",
        payload={"action": "test_ingest"},
    )
    test_db_session.add_all([evidence, contradiction, audit])
    test_db_session.commit()

    test_db_session.refresh(case)
    assert len(case.candidates) == 1
    assert len(case.audit_logs) == 1
    assert len(case.candidates[0].evidence) == 1
    assert len(case.candidates[0].contradictions) == 1

    # Test cascade delete
    test_db_session.delete(case)
    test_db_session.commit()

    assert test_db_session.query(CandidateRecord).count() == 0
    assert test_db_session.query(MatchEvidence).count() == 0
    assert test_db_session.query(Contradiction).count() == 0
    assert test_db_session.query(AuditLog).count() == 0


def test_case_number_unique_constraint(test_db_session: Session) -> None:
    workspace = Workspace(name="First workspace")
    other_workspace = Workspace(name="Second workspace")
    test_db_session.add_all([workspace, other_workspace])
    test_db_session.flush()
    case1 = Case(
        workspace_id=workspace.id,
        case_number="CASE-UNIQUE-1",
        raw_name="Alice Smith",
        normalized_name="alice smith",
    )
    case2 = Case(
        workspace_id=workspace.id,
        case_number="CASE-UNIQUE-1",
        raw_name="Bob Jones",
        normalized_name="bob jones",
    )
    test_db_session.add(case1)
    test_db_session.commit()

    test_db_session.add(case2)
    with pytest.raises(IntegrityError):
        test_db_session.commit()
    test_db_session.rollback()

    other_case = Case(
        workspace_id=other_workspace.id,
        case_number="CASE-UNIQUE-1",
        raw_name="Bob Jones",
        normalized_name="bob jones",
    )
    test_db_session.add(other_case)
    test_db_session.commit()
