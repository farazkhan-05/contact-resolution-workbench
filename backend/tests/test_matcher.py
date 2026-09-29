from app.schemas.resolution import CaseQuery, RawCandidate
from app.services.matcher import (
    calculate_total_score,
    score_candidate,
    score_email,
    score_employer,
    score_location,
    score_name,
    score_phone,
)


def test_score_name() -> None:
    # Exact
    res = score_name("Claire Reynolds", "Claire Reynolds")
    assert res.points_awarded == 30
    assert res.match_method == "EXACT_MATCH"

    # Middle initial variation
    res_mid = score_name("Robert Taylor", "Robert J. Taylor")
    assert res_mid.points_awarded == 20
    assert res_mid.match_method == "MIDDLE_INITIAL_VARIATION"

    # High token similarity
    res_high = score_name("Arthur James Pendelton Jr.", "Arthur James Pendelton Sr.")
    assert res_high.points_awarded == 20
    assert res_high.match_method == "HIGH_SIMILARITY"

    # Moderate similarity
    res_mod = score_name("Tariq Al-Mansoor", "Tariq Mansour")
    assert res_mod.points_awarded == 10
    assert res_mod.match_method == "MODERATE_SIMILARITY"

    # Missing
    res_miss = score_name(None, "Claire Reynolds")
    assert res_miss.points_awarded == 0
    assert res_miss.match_method == "MISSING"


def test_score_email() -> None:
    assert score_email("test@demo.com", "test@demo.com").points_awarded == 25
    assert score_email("test1@demo.com", "test2@demo.com").points_awarded == 0
    assert score_email(None, "test@demo.com").points_awarded == 0


def test_score_phone() -> None:
    assert score_phone("+1 202-555-0123", "+1 (202) 555-0123").points_awarded == 25
    assert score_phone("+1 202-555-0188", "+1 202-555-0199").points_awarded == 0
    assert score_phone(None, "+1 202-555-0123").points_awarded == 0


def test_score_employer() -> None:
    assert score_employer("Acme Health Group", "Acme Health Group Inc").points_awarded == 10
    assert score_employer("Summit Technologies", "Summit Technologies Software").points_awarded == 6
    assert score_employer("Apex Supply", "Orion Energy").points_awarded == 0
    assert score_employer(None, "Acme").points_awarded == 0


def test_score_location() -> None:
    # Exact City + State
    assert score_location("Chicago, IL", "Chicago, Illinois").points_awarded == 10
    # Same State only
    assert score_location("Seattle, WA", "Spokane, WA").points_awarded == 5
    # Conflicting State
    assert score_location("Dallas, TX", "Atlanta, GA").points_awarded == 0
    # Missing
    assert score_location(None, "Austin, TX").points_awarded == 0


def test_candidate_scoring_and_caps() -> None:
    query = CaseQuery(
        name="Claire Reynolds",
        email="claire.reynolds@acmehealth.demo",
        phone="+1 202-555-0123",
        employer="Acme Health Group",
        location="Chicago, IL",
    )
    cand = RawCandidate(
        provider_source="CRM_ARCHIVE",
        provider_record_id="CRM-1",
        name="Claire Reynolds",
        email="claire.reynolds@acmehealth.demo",
        phone="+1 (202) 555-0123",
        employer="Acme Health Group Inc",
        location="Chicago, Illinois",
        provenance_summary="Test",
    )
    evidence = score_candidate(query, cand)
    total = calculate_total_score(evidence)
    assert total == 100
    assert total <= 100
