import ast
import hashlib
import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from app.core.constants import RoutingStatus
from app.schemas.resolution import CandidateResolution, CaseQuery, RawCandidate
from app.services.resolution_service import ResolutionService
from app.services.router import route_resolution
from benchmarks.identity_resolution.dataset import Dataset, generate
from benchmarks.identity_resolution.evaluate import partition
from benchmarks.identity_resolution.routing import (
    CURRENT,
    Case,
    Observation,
    Policy,
    build_cases,
    distributions,
    gate_audit,
    metrics,
    report,
    route,
    select_policy,
    unsafe_auto,
)
from benchmarks.identity_resolution.routing_experiment import (
    RESULTS,
    develop,
    frozen_integrity,
    run,
)


@pytest.fixture(scope="module")
def data() -> Dataset:
    return generate()


@pytest.fixture(scope="module")
def validation(data: Dataset) -> tuple[Case, ...]:
    return build_cases(data, "validation")


def case(score: int, correct: bool = True, blocked: bool = False, no_match: bool = False) -> Case:
    resolution = CandidateResolution(
        candidate=RawCandidate(
            name="Test Person",
            provider_source="TEST",
            provider_record_id="a",
            provenance_summary="Test",
        ),
        total_score=score,
        has_serious_contradiction=blocked,
    )
    return Case(
        "q",
        "validation",
        (),
        no_match,
        not no_match,
        not no_match,
        (),
        (Observation(resolution, correct, ()),),
    )


def test_current_evaluation_reproduces_actual_router(validation: tuple[Case, ...]) -> None:
    for item in validation:
        assert route(item) == route_resolution([c.resolution for c in item.candidates])[1]
    assert report(validation) == report(validation)
    assert report(validation) == report(build_cases(generate(), "validation"))


def test_preserves_c1_candidate_order_and_component_scores(
    data: Dataset, validation: tuple[Case, ...]
) -> None:
    queries, retriever = partition(data, "validation")
    for query, item in zip(queries, validation, strict=True):
        assert [
            c.resolution.candidate.provider_record_id for c in item.candidates
        ] == retriever.search(query, "validation")
        for c in item.candidates:
            assert c.resolution.total_score == sum(
                e.points_awarded for e in c.resolution.field_evidence
            )


def test_safety_objective_precedes_coverage_and_proximity() -> None:
    train = [replace(case(75), split="train")]
    validation = [case(75), case(70, correct=False)]
    chosen, _ = select_policy(train, validation, [Policy(70, 45), CURRENT, Policy(80, 45)])
    assert chosen == CURRENT  # More auto coverage at 70 is unsafe; 80 loses a safe auto.


@pytest.mark.parametrize("target", ["train", "validation"])
def test_selection_rejects_held_out_inputs(target: str) -> None:
    train = [replace(case(80), split="train")]
    validation = [case(80)]
    if target == "train":
        train = [replace(case(80), split="test")]
    else:
        validation = [replace(case(80), split="test")]
    with pytest.raises(ValueError, match="never held-out"):
        select_policy(train, validation, [CURRENT])
    with pytest.raises(ValueError, match="held-out"):
        distributions([replace(case(80), split="test")])


def test_development_never_builds_test_cases(
    monkeypatch: pytest.MonkeyPatch, data: Dataset
) -> None:
    from benchmarks.identity_resolution import routing_experiment

    calls = []
    original = routing_experiment.build_cases

    def guarded(dataset: Dataset, split: Any) -> tuple[Case, ...]:
        calls.append(split)
        assert split != "test"
        return original(dataset, split)

    monkeypatch.setattr(routing_experiment, "build_cases", guarded)
    selection, _, _ = develop(data)
    assert calls == ["train", "validation"]
    assert selection["selection_splits"] == ["train", "validation"]


def test_held_out_requires_matching_freeze_before_building_test(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from benchmarks.identity_resolution import routing_experiment

    monkeypatch.setattr(routing_experiment, "frozen_integrity", lambda _: {})
    monkeypatch.setattr(routing_experiment, "develop", lambda _: ({"freeze": "expected"}, {}, {}))
    (tmp_path / "selection.json").write_text('{"freeze": "different"}', encoding="utf-8")

    def forbidden(*args: object) -> None:
        pytest.fail("Held-out cases opened before matching the policy freeze")

    monkeypatch.setattr(routing_experiment, "build_cases", forbidden)
    with pytest.raises(ValueError, match="frozen selection"):
        run(tmp_path, held_out=True)


@pytest.mark.parametrize(
    "correct,blocked,expected",
    [(True, False, False), (False, False, True), (True, True, True), (False, True, True)],
)
def test_unsafe_auto_definition(correct: bool, blocked: bool, expected: bool) -> None:
    assert unsafe_auto(RoutingStatus.LIKELY_MATCH, correct, blocked) == expected
    assert not unsafe_auto(RoutingStatus.NEEDS_REVIEW, correct, blocked)


def test_explicit_denominators_and_separate_no_match() -> None:
    cases = [
        case(90),
        case(90, correct=False, no_match=True),
        case(50, correct=False),
        case(20),
        replace(case(0, correct=False, no_match=True), candidates=()),
    ]
    result = metrics(cases)
    assert result["routes"] == {"LIKELY_MATCH": 2, "NEEDS_REVIEW": 1, "NO_RELIABLE_MATCH": 2}
    assert result["safe_auto"] == 1
    assert result["wrong_auto"] == result["unsafe_auto"] == 1
    assert result["wrong_auto_per_auto"] == result["unsafe_auto_per_auto"] == 1 / 2
    assert result["wrong_auto_per_query"] == result["unsafe_auto_per_query"] == 1 / 5
    assert result["intentional_no_match"]["queries"] == 2
    assert result["intentional_no_match"]["routes"] == {
        "LIKELY_MATCH": 1,
        "NEEDS_REVIEW": 0,
        "NO_RELIABLE_MATCH": 1,
    }
    assert result["false_no_match_corpus"] == 1
    assert result["false_no_match_rate_corpus"] == 1 / 3
    assert result["review_wrong_top"] == 1
    assert result["review_or_abstention_rate"] == 3 / 5


def test_empty_denominators_and_retrieval_misses_are_explicit() -> None:
    empty = metrics([])
    assert empty["wrong_auto_per_auto"] is None
    assert empty["unsafe_auto_per_query"] is None
    missed = replace(case(0), candidates=(), true_retrieved=False)
    result = metrics([missed])
    assert result["false_no_match_corpus"] == 1
    assert result["false_no_match_retrieved"] == 0
    assert result["false_no_match_rate_retrieved"] is None


def test_query_gate_counts_do_not_double_count_pairs() -> None:
    blocked = case(100, correct=False, blocked=True)
    result = metrics([blocked])
    assert result["unsafe_auto"] == 0
    assert result["contradictions"]["blocked_auto_prevented"] == 1
    assert result["contradictions"]["blocked_wrong_auto_prevented"] == 1
    assert result["contradictions"]["hard_contradiction_review"] == 1


@pytest.mark.parametrize(
    "source,target,kind",
    [
        ("Arthur James Pendelton Jr.", "Arthur James Pendelton Sr.", "INCOMPATIBLE_NAME_SUFFIX"),
        ("Arthur James Pendelton II", "Arthur James Pendelton III", "INCOMPATIBLE_NAME_SUFFIX"),
        ("Arthur Alexander Pendelton", "Arthur Anthony Pendelton", "CONFLICTING_FULL_MIDDLE_NAME"),
    ],
)
def test_high_contact_agreement_and_injected_max_score_cannot_bypass_gate(
    source: str, target: str, kind: str
) -> None:
    contact = {
        "email": "same@example.invalid",
        "phone": "+1 000 555 123456",
        "employer": "Example LLC",
        "location": "Boston, MA",
    }
    query = CaseQuery(name=source, **contact)
    candidate = RawCandidate(
        name=target,
        provider_source="TEST",
        provider_record_id="b",
        provenance_summary="Test",
        **contact,
    )
    resolved = ResolutionService().resolve_candidate(query, candidate)
    assert resolved.total_score >= 75
    assert any(
        c.contradiction_type == kind and c.blocks_likely_match for c in resolved.contradictions
    )
    for score in (resolved.total_score, 100):
        item = replace(
            case(score, correct=False, blocked=True),
            candidates=(
                Observation(resolved.model_copy(update={"total_score": score}), False, ()),
            ),
        )
        for policy in (CURRENT, Policy(65, 40), Policy(85, 55)):
            assert route(item, policy) == RoutingStatus.NEEDS_REVIEW
            assert metrics([item], policy)["unsafe_auto"] == 0


def test_ties_use_first_frozen_c1_candidate_and_router_uses_max() -> None:
    first = case(90).candidates[0]
    second = replace(
        first,
        correct=False,
        resolution=first.resolution.model_copy(
            update={
                "candidate": first.resolution.candidate.model_copy(
                    update={"provider_record_id": "b"}
                )
            }
        ),
    )
    item = replace(case(90), candidates=(first, second))
    assert item.top is first
    assert metrics([item])["safe_auto"] == 1
    assert replace(item, candidates=(second, first)).top is second
    higher_blocked = replace(
        second,
        resolution=second.resolution.model_copy(
            update={"total_score": 100, "has_serious_contradiction": True}
        ),
    )
    item = replace(item, candidates=(first, higher_blocked))
    assert item.top is higher_blocked
    assert route(item) == RoutingStatus.NEEDS_REVIEW


@pytest.mark.parametrize(
    "likely,review", [(45, 45), (40, 75), (101, 45), (75, -1), (float("nan"), 45)]
)
def test_invalid_threshold_ordering(likely: float, review: float) -> None:
    with pytest.raises(ValueError, match="Thresholds"):
        Policy(likely, review)


def test_counts_sum_and_missing_field_analysis_exists(validation: tuple[Case, ...]) -> None:
    result = report(validation)
    assert sum(result["metrics"]["routes"].values()) == len(validation)
    for value in result["scenarios"].values():
        assert sum(value["routes"].values()) == value["queries"]
    assert result["scenarios"]["missing_fields"]["queries"] > 0
    assert result["missingness"]["query_missing_any"]["queries"] > 0
    assert result["missingness"]["query_complete"]["queries"] + result["missingness"][
        "query_missing_any"
    ]["queries"] == len(validation)
    gates = gate_audit(validation)
    assert gates["INCOMPATIBLE_NAME_SUFFIX"]["isolated_likely"] == 0
    assert gates["CONFLICTING_FULL_MIDDLE_NAME"]["isolated_likely"] == 0


def test_frozen_benchmark_and_all_c1_c2_c3_artifacts(data: Dataset) -> None:
    hashes = frozen_integrity(data)
    recorded = json.loads((RESULTS / "c4" / "manifest.json").read_text(encoding="utf-8"))
    assert recorded["dataset_manifest"] == data.manifest()
    assert recorded["pre_c4_artifact_sha256"] == hashes
    assert any(k.startswith("c2/") for k in hashes)
    assert any(k.startswith("c3/") for k in hashes)
    for name, expected in hashes.items():
        assert hashlib.sha256((RESULTS / name).read_bytes()).hexdigest() == expected


def test_no_ml_or_semantic_imports_in_routing_or_production() -> None:
    root = Path(__file__).resolve().parents[1]
    paths = list((root / "app").rglob("*.py")) + [
        root / "benchmarks/identity_resolution" / f for f in ("routing.py", "routing_experiment.py")
    ]
    forbidden = (
        "sklearn",
        "xgboost",
        "sentence_transformers",
        "learned_ranking",
        "semantic",
        "embedding_providers",
    )
    for path in paths:
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Import):
                modules = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                modules = [node.module or ""]
            else:
                continue
            assert not any(part in module.split(".") for module in modules for part in forbidden), (
                path
            )
