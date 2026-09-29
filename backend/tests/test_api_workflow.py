from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base, get_db
from app.main import app
from app.models.case import Case
from app.schemas.resolution import CaseQuery, RawCandidate
from app.services.case_service import ingest_sample_cases
from app.services.resolution_service import ResolutionService

# Isolated in-memory SQLite test database
SQLALCHEMY_DATABASE_URL = "sqlite:///:memory:"

engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


@pytest.fixture(autouse=True)
def setup_db() -> Generator[None]:
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


def override_get_db() -> Generator[Session]:
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()


app.dependency_overrides[get_db] = override_get_db
client = TestClient(app)


def test_sample_ingest_and_idempotency() -> None:
    # 1. First sample ingest
    res1 = client.post("/api/v1/ingest/sample")
    assert res1.status_code == 200
    data1 = res1.json()
    assert data1["ingested_count"] == 8
    assert data1["created_count"] == 8
    assert data1["existing_count"] == 0
    assert len(data1["case_ids"]) == 8

    # Record a decision on one case
    case_id_1 = data1["case_ids"][0]
    detail_res = client.get(f"/api/v1/cases/{case_id_1}")
    cand_id = detail_res.json()["candidates"][0]["id"]
    dec_res = client.post(
        f"/api/v1/cases/{case_id_1}/decision",
        json={"decision": "ACCEPTED", "selected_candidate_id": cand_id, "notes": "Verified"},
    )
    assert dec_res.status_code == 200

    # 2. Second sample ingest (must be idempotent)
    res2 = client.post("/api/v1/ingest/sample")
    assert res2.status_code == 200
    data2 = res2.json()
    assert data2["ingested_count"] == 8
    assert data2["created_count"] == 0
    assert data2["existing_count"] == 8
    assert data2["case_ids"] == data1["case_ids"]

    # Verify decision was NOT overwritten
    detail_after = client.get(f"/api/v1/cases/{case_id_1}").json()
    assert detail_after["review_decision"] == "ACCEPTED"
    assert detail_after["reviewer_notes"] == "Verified"


def test_case_list_and_filters() -> None:
    client.post("/api/v1/ingest/sample")

    # 3. GET all cases
    all_res = client.get("/api/v1/cases")
    assert all_res.status_code == 200
    all_cases = all_res.json()
    assert len(all_cases) == 8

    # 4. Filter by routing_status
    likely_res = client.get("/api/v1/cases?routing_status=LIKELY_MATCH")
    assert likely_res.status_code == 200
    likely_cases = likely_res.json()
    assert len(likely_cases) == 3
    for c in likely_cases:
        assert c["routing_status"] == "LIKELY_MATCH"

    needs_review_res = client.get("/api/v1/cases?routing_status=NEEDS_REVIEW")
    assert len(needs_review_res.json()) == 4

    no_match_res = client.get("/api/v1/cases?routing_status=NO_RELIABLE_MATCH")
    assert len(no_match_res.json()) == 1

    # 5. Filter by review_decision
    pending_res = client.get("/api/v1/cases?review_decision=PENDING")
    assert len(pending_res.json()) == 8

    # 6. Simple search
    search_res = client.get("/api/v1/cases?search=Reynolds")
    assert search_res.status_code == 200
    assert len(search_res.json()) == 1
    assert search_res.json()[0]["person_name"] == "Claire Reynolds"


def test_case_details_verification() -> None:
    client.post("/api/v1/ingest/sample")
    cases = client.get("/api/v1/cases").json()
    case_map = {c["case_number"]: c["id"] for c in cases}

    # 7. CASE-1001 (Claire Reynolds) -> score 100, evidence rows, provenance
    c1001 = client.get(f"/api/v1/cases/{case_map['CASE-1001']}").json()
    assert c1001["case_number"] == "CASE-1001"
    assert c1001["routing_status"] == "LIKELY_MATCH"
    assert len(c1001["candidates"]) == 1
    cand1 = c1001["candidates"][0]
    assert cand1["total_score"] == 100
    assert len(cand1["evidence"]) == 5
    assert "CRM Archive" in cand1["provenance_summary"]

    # 8. CASE-1004 (Robert Taylor) -> contains at least 2 candidates in deterministic order
    c1004 = client.get(f"/api/v1/cases/{case_map['CASE-1004']}").json()
    assert len(c1004["candidates"]) == 2
    assert c1004["candidates"][0]["total_score"] == 55
    assert c1004["candidates"][0]["name"] == "Robert J. Taylor"
    assert c1004["candidates"][1]["total_score"] == 50
    assert c1004["candidates"][1]["name"] == "Robert Taylor"

    # 9. CASE-1005 (Arthur Pendelton Jr.) -> score 90, SERIOUS contradiction, NEEDS_REVIEW
    c1005 = client.get(f"/api/v1/cases/{case_map['CASE-1005']}").json()
    assert c1005["routing_status"] == "NEEDS_REVIEW"
    assert c1005["candidates"][0]["total_score"] == 90
    assert c1005["candidates"][0]["has_serious_contradiction"] is True
    assert any(
        ct["contradiction_type"] == "INCOMPATIBLE_NAME_SUFFIX"
        and ct["severity"] == "SERIOUS"
        and ct["blocks_likely_match"] is True
        for ct in c1005["candidates"][0]["contradictions"]
    )

    # 10. CASE-1006 (Marcus Sterling) -> MODERATE warnings
    c1006 = client.get(f"/api/v1/cases/{case_map['CASE-1006']}").json()
    assert c1006["routing_status"] == "NEEDS_REVIEW"
    assert c1006["candidates"][0]["has_serious_contradiction"] is False
    assert len(c1006["candidates"][0]["contradictions"]) == 2
    for ct in c1006["candidates"][0]["contradictions"]:
        assert ct["severity"] == "MODERATE"
        assert ct["blocks_likely_match"] is False


def test_reviewer_decision_workflow() -> None:
    client.post("/api/v1/ingest/sample")
    cases = client.get("/api/v1/cases").json()
    case_1 = cases[0]
    case_id_1 = case_1["id"]
    cand_id_1 = client.get(f"/api/v1/cases/{case_id_1}").json()["candidates"][0]["id"]

    case_2 = cases[1]
    case_id_2 = case_2["id"]
    cand_id_2 = client.get(f"/api/v1/cases/{case_id_2}").json()["candidates"][0]["id"]

    # 11. ACCEPTED with valid candidate succeeds
    dec_res = client.post(
        f"/api/v1/cases/{case_id_1}/decision",
        json={
            "decision": "ACCEPTED",
            "selected_candidate_id": cand_id_1,
            "notes": "Reviewed and confirmed match",
        },
    )
    assert dec_res.status_code == 200
    detail = dec_res.json()
    assert detail["review_decision"] == "ACCEPTED"
    assert detail["selected_candidate_id"] == cand_id_1
    assert detail["reviewer_notes"] == "Reviewed and confirmed match"
    assert detail["reviewed_at"] is not None

    # 12. ACCEPTED without selected_candidate_id fails
    err1 = client.post(
        f"/api/v1/cases/{case_id_2}/decision",
        json={"decision": "ACCEPTED", "selected_candidate_id": None},
    )
    assert err1.status_code == 422
    assert "ACCEPTED requires a candidate" in err1.json()["detail"]

    # 13. ACCEPTED using candidate from another case fails
    err2 = client.post(
        f"/api/v1/cases/{case_id_1}/decision",
        json={"decision": "ACCEPTED", "selected_candidate_id": cand_id_2},
    )
    assert err2.status_code == 422
    assert "Selected candidate does not belong to this case" in err2.json()["detail"]

    # 14. REJECTED with candidate ID fails
    err3 = client.post(
        f"/api/v1/cases/{case_id_2}/decision",
        json={"decision": "REJECTED", "selected_candidate_id": cand_id_2},
    )
    assert err3.status_code == 422

    # 15. NEED_MORE_EVIDENCE succeeds without candidate
    need_res = client.post(
        f"/api/v1/cases/{case_id_2}/decision",
        json={"decision": "NEED_MORE_EVIDENCE", "notes": "Need employment verification"},
    )
    assert need_res.status_code == 200
    assert need_res.json()["review_decision"] == "NEED_MORE_EVIDENCE"
    assert need_res.json()["selected_candidate_id"] is None

    # 16. Decision does NOT mutate original contact fields
    c1_after = client.get(f"/api/v1/cases/{case_id_1}").json()
    assert c1_after["raw_name"] == case_1["person_name"]
    assert c1_after["raw_employer"] == case_1["employer"]

    # 17. Decision appends DECISION_RECORDED audit event with actor demo-reviewer
    audits = c1_after["audit_logs"]
    decision_audits = [a for a in audits if a["event_type"] == "DECISION_RECORDED"]
    assert len(decision_audits) >= 1
    assert decision_audits[0]["actor"] == "demo-reviewer"

    # 18. Revising decision: updates current state, preserves earlier audit events
    rev_res = client.post(
        f"/api/v1/cases/{case_id_1}/decision",
        json={"decision": "REJECTED", "notes": "Disputed upon closer inspection"},
    )
    assert rev_res.status_code == 200
    rev_detail = rev_res.json()
    assert rev_detail["review_decision"] == "REJECTED"
    assert rev_detail["selected_candidate_id"] is None

    all_audits = rev_detail["audit_logs"]
    decision_events = [a for a in all_audits if a["event_type"] == "DECISION_RECORDED"]
    assert len(decision_events) == 2
    assert decision_events[0]["payload"]["previous_decision"] == "ACCEPTED"
    assert decision_events[0]["payload"]["decision"] == "REJECTED"


def test_csv_ingestion_and_validation() -> None:
    # 19. Valid CSV upload succeeds
    valid_csv = """case_number,full_name,old_email,old_phone,employer,location
CASE-CSV-01,Alice Springs,alice@springs.demo,+1 202-555-0101,Springs Co,Seattle WA
CASE-CSV-02,Bob Vance,bob@vance.demo,+1 202-555-0102,Vance Refrig,Austin TX
"""
    res = client.post(
        "/api/v1/ingest/csv",
        files={"file": ("test.csv", valid_csv.encode("utf-8"), "text/csv")},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["ingested_count"] == 2
    assert data["created_count"] == 2

    # 20. Missing required header fails
    missing_header_csv = """case_id,full_name\nCASE-99,John Doe"""
    res_m = client.post(
        "/api/v1/ingest/csv",
        files={"file": ("test.csv", missing_header_csv.encode("utf-8"), "text/csv")},
    )
    assert res_m.status_code == 422
    assert "missing required column: case_number" in res_m.json()["detail"]

    # 21. Blank required row value fails with row number
    blank_name_csv = """case_number,full_name\nCASE-10,Valid Name\nCASE-11,  """
    res_b = client.post(
        "/api/v1/ingest/csv",
        files={"file": ("test.csv", blank_name_csv.encode("utf-8"), "text/csv")},
    )
    assert res_b.status_code == 422
    assert "Row 3: full_name is required" in res_b.json()["detail"]

    # 22. Duplicate case_number within file fails
    dup_file_csv = """case_number,full_name\nCASE-20,Person One\nCASE-20,Person Two"""
    res_dup = client.post(
        "/api/v1/ingest/csv",
        files={"file": ("test.csv", dup_file_csv.encode("utf-8"), "text/csv")},
    )
    assert res_dup.status_code == 422
    assert "duplicate case_number 'CASE-20'" in res_dup.json()["detail"]

    # 23. Existing database case_number fails
    existing_db_csv = """case_number,full_name\nCASE-CSV-01,Duplicate In DB"""
    res_db = client.post(
        "/api/v1/ingest/csv",
        files={"file": ("test.csv", existing_db_csv.encode("utf-8"), "text/csv")},
    )
    assert res_db.status_code == 422
    assert "case_number 'CASE-CSV-01' already exists in database" in res_db.json()["detail"]

    # 24. Invalid batch persists zero rows
    before_count = len(client.get("/api/v1/cases").json())
    fail_batch = """case_number,full_name\nCASE-NEW-1,Valid One\nCASE-NEW-2,"""
    client.post(
        "/api/v1/ingest/csv",
        files={"file": ("test.csv", fail_batch.encode("utf-8"), "text/csv")},
    )
    after_count = len(client.get("/api/v1/cases").json())
    assert before_count == after_count

    # 25. Arbitrary valid synthetic identity with no candidate routes to NO_RELIABLE_MATCH
    solo_csv = "case_number,full_name,old_email\nCASE-SOLO-1,Zackarias Unmatched,zack@nomatch.demo"
    solo_res = client.post(
        "/api/v1/ingest/csv",
        files={"file": ("test.csv", solo_csv.encode("utf-8"), "text/csv")},
    )
    assert solo_res.status_code == 200
    solo_case_id = solo_res.json()["case_ids"][0]
    solo_detail = client.get(f"/api/v1/cases/{solo_case_id}").json()
    assert solo_detail["routing_status"] == "NO_RELIABLE_MATCH"
    assert len(solo_detail["candidates"]) == 0


def test_csv_export() -> None:
    client.post("/api/v1/ingest/sample")
    cases = client.get("/api/v1/cases").json()

    # 26. Before any review, export is empty of data rows
    export_pre = client.get("/api/v1/export/csv")
    assert export_pre.status_code == 200
    lines_pre = [line for line in export_pre.text.strip().splitlines() if line]
    assert len(lines_pre) == 1  # Header only

    # Review two cases
    c1 = cases[0]
    cand_1 = client.get(f"/api/v1/cases/{c1['id']}").json()["candidates"][0]
    client.post(
        f"/api/v1/cases/{c1['id']}/decision",
        json={"decision": "ACCEPTED", "selected_candidate_id": cand_1["id"], "notes": "Approved"},
    )

    c2 = cases[1]
    client.post(
        f"/api/v1/cases/{c2['id']}/decision",
        json={"decision": "REJECTED", "notes": "No match found"},
    )

    # 27. Export contains exactly the 2 reviewed cases
    export_post = client.get("/api/v1/export/csv")
    assert export_post.status_code == 200
    lines = [line for line in export_post.text.strip().splitlines() if line]
    assert len(lines) == 3  # Header + 2 data rows

    # 28. Accepted candidate fields appear correctly
    assert "ACCEPTED" in export_post.text
    assert cand_1["id"] in export_post.text
    assert cand_1["name"] in export_post.text

    # 29. Rejected case has blank selected-candidate fields
    assert "REJECTED" in export_post.text


class FailingProvider:
    provider_id: str = "FAILING_PROVIDER"
    provider_name: str = "Failing Provider"

    def search(self, query: CaseQuery) -> list[RawCandidate]:
        raise RuntimeError("External connection timeout simulator")


def test_provider_failure_safety() -> None:
    db = TestingSessionLocal()
    try:
        failing_resolver = ResolutionService(providers=[FailingProvider()])
        # 30. Injected failing provider raises ProviderError rather than returning NO_RELIABLE_MATCH
        with pytest.raises(Exception) as exc_info:
            failing_resolver.resolve(CaseQuery(name="Claire Reynolds"))
        assert "Candidate evidence could not be retrieved" in str(exc_info.value)

        # 31. Provider failure leaves no partial persisted case in database
        initial_count = db.query(Case).count()
        with pytest.raises(Exception):
            ingest_sample_cases(db, resolution_service=failing_resolver)
        assert db.query(Case).count() == initial_count
    finally:
        db.close()


def test_csv_ingestion_utf8_bom() -> None:
    bom_csv = "\ufeffcase_number,full_name,old_email\nCASE-BOM-01,BOM Tester,bom@test.demo\n"
    res = client.post(
        "/api/v1/ingest/csv",
        files={"file": ("test_bom.csv", bom_csv.encode("utf-8"), "text/csv")},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["ingested_count"] == 1
    case_id = data["case_ids"][0]
    detail = client.get(f"/api/v1/cases/{case_id}").json()
    assert detail["case_number"] == "CASE-BOM-01"
    assert detail["raw_name"] == "BOM Tester"


def test_csv_export_formula_injection_sanitization() -> None:
    client.post("/api/v1/ingest/sample")
    cases = client.get("/api/v1/cases").json()
    c1 = cases[0]
    cand_1 = client.get(f"/api/v1/cases/{c1['id']}").json()["candidates"][0]
    client.post(
        f"/api/v1/cases/{c1['id']}/decision",
        json={
            "decision": "ACCEPTED",
            "selected_candidate_id": cand_1["id"],
            "notes": '=HYPERLINK("http://evil.demo","Click")',
        },
    )
    c2 = cases[1]
    client.post(
        f"/api/v1/cases/{c2['id']}/decision",
        json={
            "decision": "REJECTED",
            "notes": "@SUM(1+1)",
        },
    )
    export_res = client.get("/api/v1/export/csv")
    assert export_res.status_code == 200
    assert "'=HYPERLINK" in export_res.text
    assert "'@SUM(1+1)" in export_res.text


def test_datetime_decision_activity_ordering_sequence() -> None:
    client.post("/api/v1/ingest/sample")
    cases = client.get("/api/v1/cases").json()
    c1 = cases[0]
    case_id = c1["id"]
    cand_id = client.get(f"/api/v1/cases/{case_id}").json()["candidates"][0]["id"]

    # Submit decision
    dec_res1 = client.post(
        f"/api/v1/cases/{case_id}/decision",
        json={"decision": "ACCEPTED", "selected_candidate_id": cand_id, "notes": "Initial note"},
    )
    assert dec_res1.status_code == 200

    # Revise decision
    dec_res2 = client.post(
        f"/api/v1/cases/{case_id}/decision",
        json={"decision": "REJECTED", "notes": "+1234567890 leading plus"},
    )
    assert dec_res2.status_code == 200

    # Fetch case detail to verify activity timeline sorting without TypeError
    detail = client.get(f"/api/v1/cases/{case_id}").json()
    logs = detail["audit_logs"]
    assert len(logs) >= 4
    timestamps = [log["created_at"] for log in logs]
    assert timestamps == sorted(timestamps, reverse=True)
