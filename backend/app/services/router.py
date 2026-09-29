from app.core.constants import (
    THRESHOLD_LIKELY_MATCH,
    THRESHOLD_NEEDS_REVIEW,
    RoutingStatus,
)
from app.schemas.resolution import CandidateResolution


def route_resolution(
    candidates: list[CandidateResolution],
) -> tuple[int, RoutingStatus, str]:
    """Determine top score, routing status, and human-readable reason."""
    if not candidates:
        return (
            0,
            RoutingStatus.NO_RELIABLE_MATCH,
            "Available evidence is insufficient for a reliable match.",
        )

    top_candidate = max(candidates, key=lambda c: c.total_score)
    top_score = top_candidate.total_score

    if top_score >= THRESHOLD_LIKELY_MATCH:
        if top_candidate.has_serious_contradiction:
            return (
                top_score,
                RoutingStatus.NEEDS_REVIEW,
                "High evidence score blocked by a serious contradiction requiring human review.",
            )
        return (
            top_score,
            RoutingStatus.LIKELY_MATCH,
            "Strong evidence score with no blocking contradiction.",
        )
    elif top_score >= THRESHOLD_NEEDS_REVIEW:
        return (
            top_score,
            RoutingStatus.NEEDS_REVIEW,
            "Partial evidence requires human review.",
        )
    else:
        return (
            top_score,
            RoutingStatus.NO_RELIABLE_MATCH,
            "Available evidence is insufficient for a reliable match.",
        )
