from typing import Any

import pytest

from app.core.constants import ContradictionSeverity, RoutingStatus
from app.schemas.resolution import CaseQuery
from app.services.fixtures import BENCHMARK_CASES
from app.services.resolution_service import ResolutionService


@pytest.fixture
def resolution_service() -> ResolutionService:
    return ResolutionService()


@pytest.mark.parametrize(
    "case_info",
    BENCHMARK_CASES,
    ids=[str(c["case_number"]) for c in BENCHMARK_CASES],
)
def test_benchmark_scenarios(
    resolution_service: ResolutionService, case_info: dict[str, Any]
) -> None:
    query: CaseQuery = case_info["query"]
    expected_top_score: int = case_info["expected_top_score"]
    expected_route: str = case_info["expected_route"]
    expected_has_serious: bool = case_info["has_serious_contradiction"]

    resolution = resolution_service.resolve(query)

    assert resolution.top_score == expected_top_score, (
        f"Case {case_info['case_number']} expected score {expected_top_score}, "
        f"got {resolution.top_score}"
    )
    assert resolution.routing_status.value == expected_route, (
        f"Case {case_info['case_number']} expected route {expected_route}, "
        f"got {resolution.routing_status.value}"
    )

    if resolution.candidates:
        top_cand = resolution.candidates[0]
        assert top_cand.has_serious_contradiction == expected_has_serious


def test_case_4_ambiguous_two_candidates_sorting(
    resolution_service: ResolutionService,
) -> None:
    query = CaseQuery(
        name="Robert Taylor",
        email="rtaylor@summittech.demo",
        phone="+1 202-555-0177",
        employer="Summit Technologies",
        location="Seattle, WA",
    )
    resolution = resolution_service.resolve(query)

    assert len(resolution.candidates) == 2
    # Candidate B (Score 55) should be ranked first
    assert resolution.candidates[0].total_score == 55
    assert resolution.candidates[0].candidate.name == "Robert J. Taylor"
    # Candidate A (Score 50) should be ranked second
    assert resolution.candidates[1].total_score == 50
    assert resolution.candidates[1].candidate.name == "Robert Taylor"
    assert resolution.routing_status == RoutingStatus.NEEDS_REVIEW


def test_case_5_serious_contradiction_blocking(
    resolution_service: ResolutionService,
) -> None:
    query = CaseQuery(
        name="Arthur James Pendelton Jr.",
        name_suffix="Jr.",
        email="a.pendelton@beacon-financial.demo",
        phone="+1 202-555-0155",
        employer="Beacon Financial",
        location="New York, NY",
    )
    resolution = resolution_service.resolve(query)

    assert resolution.top_score == 90
    assert resolution.candidates[0].has_serious_contradiction is True
    assert resolution.routing_status == RoutingStatus.NEEDS_REVIEW
    assert any(
        c.severity == ContradictionSeverity.SERIOUS for c in resolution.candidates[0].contradictions
    )


def test_case_6_moderate_contradictions_only(
    resolution_service: ResolutionService,
) -> None:
    query = CaseQuery(
        name="Marcus Sterling",
        email="msterling@apexsupply.demo",
        phone="+1 202-555-0166",
        employer="Apex Supply Chain",
        location="Dallas, TX",
    )
    resolution = resolution_service.resolve(query)

    assert resolution.top_score == 55
    assert resolution.candidates[0].has_serious_contradiction is False
    assert resolution.routing_status == RoutingStatus.NEEDS_REVIEW
    # Should have moderate contradictions only
    severities = {c.severity for c in resolution.candidates[0].contradictions}
    assert ContradictionSeverity.SERIOUS not in severities
    assert ContradictionSeverity.MODERATE in severities
