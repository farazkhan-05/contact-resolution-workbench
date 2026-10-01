"""Offline routing evaluation. Frozen C1 retrieval and production scores only."""

from collections import Counter
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from typing import Any

from app.core.constants import THRESHOLD_LIKELY_MATCH, THRESHOLD_NEEDS_REVIEW, RoutingStatus
from app.schemas.resolution import CandidateResolution, CaseQuery, RawCandidate
from app.services.resolution_service import ResolutionService
from app.services.router import route_resolution
from benchmarks.identity_resolution.dataset import Dataset, Split
from benchmarks.identity_resolution.evaluate import partition


@dataclass(frozen=True)
class Policy:
    likely: float = THRESHOLD_LIKELY_MATCH
    review: float = THRESHOLD_NEEDS_REVIEW

    def __post_init__(self) -> None:
        if not 0 <= self.review < self.likely <= 100:
            raise ValueError("Thresholds must satisfy 0 <= review < likely <= 100")


CURRENT = Policy()
POLICY_VERSION = "c4-score-thresholds-hard-gates-v1"


@dataclass(frozen=True)
class Observation:
    resolution: CandidateResolution
    correct: bool
    missing_fields: tuple[str, ...]


@dataclass(frozen=True)
class Case:
    query_id: str
    split: Split
    scenarios: tuple[str, ...]
    no_correct_candidate: bool
    true_in_corpus: bool
    true_retrieved: bool
    query_missing_fields: tuple[str, ...]
    candidates: tuple[Observation, ...]

    @property
    def top(self) -> Observation | None:
        # Production router uses max, retaining first input on a score tie.
        # Input remains C1's blocked/score/opaque-ID order, without re-ranking.
        return max(self.candidates, key=lambda c: c.resolution.total_score, default=None)


def build_cases(data: Dataset, split: Split) -> tuple[Case, ...]:
    queries, retriever = partition(data, split)
    service = ResolutionService()
    cases = []
    for query in queries:
        label = data.labels[query.record_id]
        relevant = {
            record_id
            for record_id in retriever.records
            if record_id != query.record_id and data.labels[record_id].truth_id == label.truth_id
        }
        if label.no_correct_candidate != (not relevant):
            raise ValueError("Construction truth and configured corpus disagree")
        ids = retriever.search(query, split)
        observations = []
        for record_id in ids:
            resolution = service.resolve_candidate(query.profile, retriever.records[record_id])
            observations.append(
                Observation(
                    resolution,
                    record_id in relevant,
                    tuple(
                        e.field_name
                        for e in resolution.field_evidence
                        if e.match_method == "MISSING"
                    ),
                )
            )
        cases.append(
            Case(
                query.record_id,
                split,
                label.scenarios,
                label.no_correct_candidate,
                bool(relevant),
                bool(relevant.intersection(ids)),
                tuple(
                    f
                    for f in ("name", "email", "phone", "employer", "location")
                    if not getattr(query.profile, f)
                ),
                tuple(observations),
            )
        )
    return tuple(cases)


def route(case: Case, policy: Policy = CURRENT) -> RoutingStatus:
    if policy == CURRENT:
        return route_resolution([c.resolution for c in case.candidates])[1]
    top = case.top
    if top is None:
        return RoutingStatus.NO_RELIABLE_MATCH
    score = top.resolution.total_score
    if score >= policy.likely:
        return (
            RoutingStatus.NEEDS_REVIEW
            if top.resolution.has_serious_contradiction
            else RoutingStatus.LIKELY_MATCH
        )
    return RoutingStatus.NEEDS_REVIEW if score >= policy.review else RoutingStatus.NO_RELIABLE_MATCH


def unsafe_auto(status: RoutingStatus, correct: bool, hard_contradiction: bool) -> bool:
    return status == RoutingStatus.LIKELY_MATCH and (not correct or hard_contradiction)


def ratio(numerator: int, denominator: int) -> float | None:
    return numerator / denominator if denominator else None


def metrics(cases: Sequence[Case], policy: Policy = CURRENT) -> dict[str, Any]:
    counts: Counter[str] = Counter()
    no_match_scores = []
    for case in cases:
        top = case.top
        correct = top is not None and top.correct
        blocked = top is not None and top.resolution.has_serious_contradiction
        status = route(case, policy)
        counts[status.value] += 1
        counts["true_in_corpus"] += case.true_in_corpus
        counts["true_retrieved"] += case.true_retrieved
        counts["empty_candidates"] += top is None
        if status == RoutingStatus.LIKELY_MATCH:
            unsafe = unsafe_auto(status, correct, blocked)
            counts["safe_auto"] += not unsafe
            counts["wrong_auto"] += not correct
            counts["unsafe_auto"] += unsafe
        if blocked:
            counts["top_hard_contradiction"] += 1
            counts["hard_contradiction_review"] += status == RoutingStatus.NEEDS_REVIEW
            counts["hard_contradiction_no_match"] += status == RoutingStatus.NO_RELIABLE_MATCH
            if top is not None and top.resolution.total_score >= policy.likely:
                counts["blocked_auto_prevented"] += 1
                counts["blocked_wrong_auto_prevented"] += not correct
        if status == RoutingStatus.NEEDS_REVIEW:
            counts["review_correct_top"] += correct
            counts["review_wrong_top"] += top is not None and not correct
            counts["review_true_available"] += case.true_retrieved
        if case.no_correct_candidate:
            counts["intentional_no_match"] += 1
            counts[f"intentional_{status.value}"] += 1
            no_match_scores.append(top.resolution.total_score if top else 0)
        if status == RoutingStatus.NO_RELIABLE_MATCH and case.true_in_corpus:
            counts["false_no_match_corpus"] += 1
            counts["false_no_match_retrieved"] += case.true_retrieved
    n = len(cases)
    auto = counts[RoutingStatus.LIKELY_MATCH.value]
    review = counts[RoutingStatus.NEEDS_REVIEW.value]
    rejected = counts[RoutingStatus.NO_RELIABLE_MATCH.value]
    return {
        "queries": n,
        "routes": {s.value: counts[s.value] for s in RoutingStatus},
        "route_rates": {s.value: ratio(counts[s.value], n) for s in RoutingStatus},
        "safe_auto": counts["safe_auto"],
        "wrong_auto": counts["wrong_auto"],
        "unsafe_auto": counts["unsafe_auto"],
        "wrong_auto_per_auto": ratio(counts["wrong_auto"], auto),
        "wrong_auto_per_query": ratio(counts["wrong_auto"], n),
        "unsafe_auto_per_auto": ratio(counts["unsafe_auto"], auto),
        "unsafe_auto_per_query": ratio(counts["unsafe_auto"], n),
        "review_or_abstention_rate": ratio(review + rejected, n),
        "true_in_corpus": counts["true_in_corpus"],
        "true_retrieved": counts["true_retrieved"],
        "empty_candidates": counts["empty_candidates"],
        "review_correct_top": counts["review_correct_top"],
        "review_wrong_top": counts["review_wrong_top"],
        "review_true_available": counts["review_true_available"],
        "false_no_match_corpus": counts["false_no_match_corpus"],
        "false_no_match_retrieved": counts["false_no_match_retrieved"],
        "false_no_match_rate_corpus": ratio(
            counts["false_no_match_corpus"], counts["true_in_corpus"]
        ),
        "false_no_match_rate_retrieved": ratio(
            counts["false_no_match_retrieved"], counts["true_retrieved"]
        ),
        "contradictions": {
            key: counts[key]
            for key in (
                "top_hard_contradiction",
                "hard_contradiction_review",
                "hard_contradiction_no_match",
                "blocked_auto_prevented",
                "blocked_wrong_auto_prevented",
            )
        },
        "intentional_no_match": {
            "queries": counts["intentional_no_match"],
            "routes": {s.value: counts[f"intentional_{s.value}"] for s in RoutingStatus},
            "highest_top_scores": sorted(no_match_scores, reverse=True)[:5],
        },
    }


def report(cases: Sequence[Case], policy: Policy = CURRENT) -> dict[str, Any]:
    return {
        "policy": asdict(policy),
        "metrics": metrics(cases, policy),
        "scenarios": {
            scenario: compact_metrics(
                metrics([c for c in cases if scenario in c.scenarios], policy)
            )
            for scenario in sorted({s for c in cases for s in c.scenarios})
        },
        "missingness": {
            "query_missing_any": metrics([c for c in cases if c.query_missing_fields], policy),
            "top_pair_missing_any": metrics(
                [c for c in cases if c.top is not None and c.top.missing_fields], policy
            ),
            "query_complete": metrics([c for c in cases if not c.query_missing_fields], policy),
        },
    }


def compact_metrics(result: dict[str, Any]) -> dict[str, Any]:
    return {
        key: result[key]
        for key in (
            "queries",
            "routes",
            "safe_auto",
            "unsafe_auto",
            "wrong_auto",
            "review_correct_top",
            "review_wrong_top",
            "false_no_match_corpus",
            "false_no_match_retrieved",
        )
    }


def gate_audit(cases: Sequence[Case], policy: Policy = CURRENT) -> dict[str, Any]:
    """Isolate each retrieved pair to test gates even when a true top hides conflicts.

    Pair opportunities are counterfactuals, not extra prevented query-level merges.
    """
    classes: dict[str, Counter[str]] = {}
    for case in cases:
        for observation in case.candidates:
            for contradiction in observation.resolution.contradictions:
                counts = classes.setdefault(contradiction.contradiction_type, Counter())
                counts["pairs"] += 1
                if observation.resolution.total_score >= policy.likely:
                    counts["high_score_pairs"] += 1
                    counts["high_score_wrong_pairs"] += not observation.correct
                    isolated = Case(
                        case.query_id,
                        case.split,
                        case.scenarios,
                        case.no_correct_candidate,
                        case.true_in_corpus,
                        observation.correct,
                        case.query_missing_fields,
                        (observation,),
                    )
                    status = route(isolated, policy)
                    counts["isolated_likely"] += status == RoutingStatus.LIKELY_MATCH
                    counts["isolated_review"] += status == RoutingStatus.NEEDS_REVIEW
                counts["blocking_pairs"] += contradiction.blocks_likely_match
    return {key: dict(sorted(value.items())) for key, value in sorted(classes.items())}


def margin_audit(cases: Sequence[Case]) -> dict[str, Any]:
    if any(c.split == "test" for c in cases):
        raise ValueError("Margin development excludes held-out test")
    groups: dict[str, Counter[str]] = {
        "automatic": Counter(),
        "wrong_top": Counter(),
        "ambiguous": Counter(),
    }
    for case in cases:
        ordered = sorted(case.candidates, key=lambda c: -c.resolution.total_score)
        if len(ordered) < 2:
            continue
        first, second = ordered[:2]
        margin = first.resolution.total_score - second.resolution.total_score
        for condition, key in (
            (route(case) == RoutingStatus.LIKELY_MATCH, "automatic"),
            (not first.correct, "wrong_top"),
            ("ambiguous" in case.scenarios, "ambiguous"),
        ):
            if condition:
                groups[key]["queries_with_second"] += 1
                groups[key]["zero_margin"] += margin == 0
                groups[key]["zero_margin_both_true"] += (
                    margin == 0 and first.correct and second.correct
                )
    return {key: dict(value) for key, value in groups.items()}


def adversarial_gates() -> list[dict[str, Any]]:
    results = []
    for source, target in (
        ("Arthur James Pendelton Jr.", "Arthur James Pendelton Sr."),
        ("Arthur James Pendelton II", "Arthur James Pendelton III"),
        ("Arthur Alexander Pendelton", "Arthur Anthony Pendelton"),
    ):
        contact = {
            "email": "same@example.invalid",
            "phone": "+1 000 555 123456",
            "employer": "Example LLC",
            "location": "Boston, MA",
        }
        resolved = ResolutionService().resolve_candidate(
            CaseQuery(name=source, **contact),
            RawCandidate(
                name=target,
                provider_source="PROBE",
                provider_record_id="p",
                provenance_summary="Synthetic gate probe",
                **contact,
            ),
        )
        score, actual, _ = route_resolution([resolved])
        _, injected, _ = route_resolution([resolved.model_copy(update={"total_score": 100})])
        results.append(
            {
                "source": source,
                "candidate": target,
                "actual_score": score,
                "actual_route": actual.value,
                "injected_score": 100,
                "injected_route": injected.value,
                "hard_types": [
                    c.contradiction_type for c in resolved.contradictions if c.blocks_likely_match
                ],
            }
        )
    return results


def quantiles(scores: Sequence[int]) -> dict[str, Any]:
    ordered = sorted(scores)
    # Nearest rank; endpoints explicit, no numerical/plotting dependencies.
    return {"count": len(ordered)} | {
        str(p): ordered[max(0, (p * len(ordered) + 99) // 100 - 1)] if ordered else None
        for p in (0, 25, 50, 75, 95, 100)
    }


def distributions(cases: Sequence[Case]) -> dict[str, Any]:
    if any(c.split == "test" for c in cases):
        raise ValueError("Score distribution development excludes held-out test")
    pools: dict[str, list[int]] = {
        k: []
        for k in (
            "true_pairs",
            "false_pairs",
            "hard_contradiction_pairs",
            "top_true",
            "top_wrong",
            "top_no_match",
            "top_ambiguous",
            "top_hard_contradiction",
            "top_missing_fields",
        )
    }
    for case in cases:
        for candidate in case.candidates:
            pools["true_pairs" if candidate.correct else "false_pairs"].append(
                candidate.resolution.total_score
            )
            if candidate.resolution.has_serious_contradiction:
                pools["hard_contradiction_pairs"].append(candidate.resolution.total_score)
        top = case.top
        if top is None:
            continue
        score = top.resolution.total_score
        pools["top_true" if top.correct else "top_wrong"].append(score)
        for condition, key in (
            (case.no_correct_candidate, "top_no_match"),
            ("ambiguous" in case.scenarios, "top_ambiguous"),
            (top.resolution.has_serious_contradiction, "top_hard_contradiction"),
            ("missing_fields" in case.scenarios, "top_missing_fields"),
        ):
            if condition:
                pools[key].append(score)
    return {key: quantiles(values) for key, values in pools.items()}


def selection_key(policy: Policy, result: dict[str, Any]) -> tuple[float, ...]:
    # Safety, useful auto-resolution, avoid false rejections, then proximity.
    # Remaining review is acceptable; truth does not label it unnecessary.
    return (
        result["unsafe_auto"],
        -result["safe_auto"],
        result["false_no_match_corpus"],
        abs(policy.likely - CURRENT.likely) + abs(policy.review - CURRENT.review),
        policy.likely,
        policy.review,
    )


def select_policy(
    train: Sequence[Case], validation: Sequence[Case], policies: Sequence[Policy]
) -> tuple[Policy, list[dict[str, Any]]]:
    if not train or not validation or not policies:
        raise ValueError("Nonempty train, validation and policy inputs required")
    if any(c.split != "train" for c in train) or any(c.split != "validation" for c in validation):
        raise ValueError("Selection accepts only train and validation, never held-out test")
    results = [
        {"policy": asdict(p), "train": metrics(train, p), "validation": metrics(validation, p)}
        for p in policies
    ]
    index = min(
        range(len(policies)), key=lambda i: selection_key(policies[i], results[i]["validation"])
    )
    return policies[index], results


def neighborhood(policy: Policy) -> tuple[Policy, ...]:
    return tuple(
        Policy(policy.likely + delta_likely, policy.review + delta_review)
        for delta_likely, delta_review in ((-1, 0), (0, 0), (1, 0), (0, -1), (0, 1))
    )


def changed_cases(cases: Sequence[Case], policy: Policy) -> list[dict[str, Any]]:
    """Small validation audit; exposes component missingness, never selects by it."""
    return [
        {
            "query_id": c.query_id,
            "scenarios": c.scenarios,
            "before": route(c).value,
            "after": route(c, policy).value,
            "correct_top": c.top.correct if c.top else False,
            "score": c.top.resolution.total_score if c.top else 0,
            "query_missing_fields": c.query_missing_fields,
            "pair_missing_fields": c.top.missing_fields if c.top else (),
            "components": {e.field_name: e.points_awarded for e in c.top.resolution.field_evidence}
            if c.top
            else {},
        }
        for c in cases
        if route(c) != route(c, policy)
    ]
