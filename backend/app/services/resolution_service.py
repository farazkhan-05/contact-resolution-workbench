from app.schemas.resolution import (
    CandidateResolution,
    CaseQuery,
    CaseResolution,
    RawCandidate,
)
from app.services.contradiction import evaluate_contradictions
from app.services.matcher import calculate_total_score, score_candidate
from app.services.providers import (
    CandidateProvider,
    MockCrmArchiveProvider,
    MockDirectoryB2BProvider,
    MockPartnerRegistryProvider,
)
from app.services.router import route_resolution


class ProviderError(Exception):
    """Raised when a candidate provider fails during evidence retrieval."""

    pass


class ResolutionService:
    def __init__(self, providers: list[CandidateProvider] | None = None) -> None:
        self.providers = providers or [
            MockCrmArchiveProvider(),
            MockDirectoryB2BProvider(),
            MockPartnerRegistryProvider(),
        ]

    def resolve_candidate(
        self,
        query: CaseQuery,
        candidate: RawCandidate,
    ) -> CandidateResolution:
        evidence = score_candidate(query, candidate)
        total_score = calculate_total_score(evidence)

        # Extract field scores for structured access
        name_score = next((e.points_awarded for e in evidence if e.field_name == "name"), 0)
        email_score = next((e.points_awarded for e in evidence if e.field_name == "email"), 0)
        phone_score = next((e.points_awarded for e in evidence if e.field_name == "phone"), 0)
        employer_score = next((e.points_awarded for e in evidence if e.field_name == "employer"), 0)
        location_score = next((e.points_awarded for e in evidence if e.field_name == "location"), 0)

        contradictions = evaluate_contradictions(query, candidate)
        has_serious = any(c.blocks_likely_match for c in contradictions)

        return CandidateResolution(
            candidate=candidate,
            total_score=total_score,
            name_score=name_score,
            email_score=email_score,
            phone_score=phone_score,
            employer_score=employer_score,
            location_score=location_score,
            field_evidence=evidence,
            contradictions=contradictions,
            has_serious_contradiction=has_serious,
        )

    def resolve(self, query: CaseQuery) -> CaseResolution:
        raw_candidates: list[RawCandidate] = []
        for provider in self.providers:
            try:
                raw_candidates.extend(provider.search(query))
            except Exception as e:
                raise ProviderError(
                    f"Candidate evidence could not be retrieved from provider "
                    f"'{provider.provider_id}'."
                ) from e

        resolutions: list[CandidateResolution] = [
            self.resolve_candidate(query, cand) for cand in raw_candidates
        ]

        # Deterministic ranking: highest total_score first, stable secondary tie-breaker
        ranked = sorted(
            resolutions,
            key=lambda r: (
                -r.total_score,
                f"{r.candidate.provider_source}:{r.candidate.provider_record_id}",
            ),
        )

        top_score, routing_status, routing_reason = route_resolution(ranked)

        return CaseResolution(
            query=query,
            candidates=ranked,
            top_score=top_score,
            routing_status=routing_status,
            routing_reason=routing_reason,
        )
