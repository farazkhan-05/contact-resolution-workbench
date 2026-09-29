from app.core.constants import ContradictionSeverity
from app.schemas.resolution import CaseQuery, RawCandidate
from app.services.contradiction import evaluate_contradictions


def test_incompatible_name_suffix_serious_contradiction() -> None:
    query = CaseQuery(
        name="Arthur James Pendelton Jr.",
        name_suffix="Jr.",
    )
    candidate = RawCandidate(
        provider_source="CRM_ARCHIVE",
        provider_record_id="CRM-1005",
        name="Arthur James Pendelton Sr.",
        name_suffix="Sr.",
        provenance_summary="Test",
    )
    contradictions = evaluate_contradictions(query, candidate)
    serious = [c for c in contradictions if c.severity == ContradictionSeverity.SERIOUS]

    assert len(serious) == 1
    assert serious[0].contradiction_type == "INCOMPATIBLE_NAME_SUFFIX"
    assert serious[0].blocks_likely_match is True


def test_conflicting_full_middle_name_serious_contradiction() -> None:
    query = CaseQuery(
        name="Arthur Alexander Pendelton",
        middle_name="Alexander",
    )
    candidate = RawCandidate(
        provider_source="CRM_ARCHIVE",
        provider_record_id="CRM-1005",
        name="Arthur Thomas Pendelton",
        middle_name="Thomas",
        provenance_summary="Test",
    )
    contradictions = evaluate_contradictions(query, candidate)
    serious = [c for c in contradictions if c.severity == ContradictionSeverity.SERIOUS]

    assert len(serious) == 1
    assert serious[0].contradiction_type == "CONFLICTING_FULL_MIDDLE_NAME"
    assert serious[0].blocks_likely_match is True


def test_conflicting_full_middle_name_same_initial_serious_contradiction() -> None:
    query = CaseQuery(
        name="Robert Alexander Taylor",
        middle_name="Alexander",
    )
    candidate = RawCandidate(
        provider_source="CRM_ARCHIVE",
        provider_record_id="CRM-1005",
        name="Robert Anthony Taylor",
        middle_name="Anthony",
        provenance_summary="Test",
    )
    contradictions = evaluate_contradictions(query, candidate)
    serious = [c for c in contradictions if c.severity == ContradictionSeverity.SERIOUS]

    assert len(serious) == 1
    assert serious[0].contradiction_type == "CONFLICTING_FULL_MIDDLE_NAME"
    assert serious[0].blocks_likely_match is True


def test_compatible_middle_initial_does_not_trigger_serious() -> None:
    query = CaseQuery(
        name="Arthur A. Pendelton",
        middle_name="A.",
    )
    candidate = RawCandidate(
        provider_source="CRM_ARCHIVE",
        provider_record_id="CRM-1005",
        name="Arthur Alexander Pendelton",
        middle_name="Alexander",
        provenance_summary="Test",
    )
    contradictions = evaluate_contradictions(query, candidate)
    serious = [c for c in contradictions if c.severity == ContradictionSeverity.SERIOUS]
    assert len(serious) == 0


def test_missing_middle_name_does_not_trigger_contradiction() -> None:
    query = CaseQuery(
        name="Arthur Pendelton",
        middle_name=None,
    )
    candidate = RawCandidate(
        provider_source="CRM_ARCHIVE",
        provider_record_id="CRM-1005",
        name="Arthur Alexander Pendelton",
        middle_name="Alexander",
        provenance_summary="Test",
    )
    contradictions = evaluate_contradictions(query, candidate)
    serious = [c for c in contradictions if c.severity == ContradictionSeverity.SERIOUS]
    assert len(serious) == 0


def test_differing_employer_and_geography_moderate_contradictions() -> None:
    query = CaseQuery(
        name="Marcus Sterling",
        employer="Apex Supply Chain",
        location="Dallas, TX",
    )
    candidate = RawCandidate(
        provider_source="SYNTHETIC_DIR_B2B",
        provider_record_id="B2B-2006",
        name="Marcus Sterling",
        employer="Orion Energy Partners",
        location="Atlanta, GA",
        provenance_summary="Test",
    )
    contradictions = evaluate_contradictions(query, candidate)
    moderate = [c for c in contradictions if c.severity == ContradictionSeverity.MODERATE]

    assert len(moderate) == 2
    types = {c.contradiction_type for c in moderate}
    assert "DIFFERING_EMPLOYER" in types
    assert "DIFFERING_GEOGRAPHY" in types
    for c in moderate:
        assert c.blocks_likely_match is False
