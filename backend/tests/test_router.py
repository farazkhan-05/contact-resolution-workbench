from app.core.constants import RoutingStatus
from app.schemas.resolution import CandidateResolution, RawCandidate
from app.services.router import route_resolution


def make_cand_res(total_score: int, has_serious: bool = False) -> CandidateResolution:
    return CandidateResolution(
        candidate=RawCandidate(
            provider_source="TEST",
            provider_record_id="T-1",
            name="Test Name",
            provenance_summary="Test",
        ),
        total_score=total_score,
        has_serious_contradiction=has_serious,
    )


def test_router_no_candidates() -> None:
    score, status, reason = route_resolution([])
    assert score == 0
    assert status == RoutingStatus.NO_RELIABLE_MATCH
    assert "insufficient" in reason.lower()


def test_router_boundaries() -> None:
    # 100 clean -> LIKELY_MATCH
    score, status, _ = route_resolution([make_cand_res(100, False)])
    assert score == 100
    assert status == RoutingStatus.LIKELY_MATCH

    # 75 clean -> LIKELY_MATCH
    score, status, _ = route_resolution([make_cand_res(75, False)])
    assert score == 75
    assert status == RoutingStatus.LIKELY_MATCH

    # 75 + serious contradiction -> NEEDS_REVIEW
    score, status, reason = route_resolution([make_cand_res(75, True)])
    assert score == 75
    assert status == RoutingStatus.NEEDS_REVIEW
    assert "blocked by a serious contradiction" in reason.lower()

    # 74 clean -> NEEDS_REVIEW
    score, status, _ = route_resolution([make_cand_res(74, False)])
    assert score == 74
    assert status == RoutingStatus.NEEDS_REVIEW

    # 45 clean -> NEEDS_REVIEW
    score, status, _ = route_resolution([make_cand_res(45, False)])
    assert score == 45
    assert status == RoutingStatus.NEEDS_REVIEW

    # 44 clean -> NO_RELIABLE_MATCH
    score, status, _ = route_resolution([make_cand_res(44, False)])
    assert score == 44
    assert status == RoutingStatus.NO_RELIABLE_MATCH
