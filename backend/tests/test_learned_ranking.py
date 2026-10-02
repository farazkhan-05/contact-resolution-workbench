import builtins
import importlib
import json
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("sklearn")

from app.schemas.resolution import CaseQuery, RawCandidate  # noqa: E402
from benchmarks.identity_resolution.dataset import SPLITS, Dataset, generate  # noqa: E402
from benchmarks.identity_resolution.learned_ranking import (  # noqa: E402
    FEATURES,
    SCHEMA,
    Pairs,
    audit_partition,
    build_pairs,
    evaluate_scores,
    extract,
    fit_logistic,
    fit_xgboost,
    order,
    ranking_summary,
)
from benchmarks.identity_resolution.ranking_experiment import (  # noqa: E402
    report,
    selection_key,
    survives,
)


@pytest.fixture(scope="module")
def data() -> Dataset:
    return generate()


@pytest.fixture(scope="module")
def batches(data: Dataset) -> dict[str, Pairs]:
    return {s: build_pairs(data, s) for s in SPLITS}


def test_feature_order_determinism_and_product_only_inputs() -> None:
    assert FEATURES == (
        "name_component",
        "email_exact",
        "phone_exact",
        "employer_component",
        "geography_component",
        "full_name_similarity",
        "first_name_similarity",
        "last_name_similarity",
        "middle_initial_agreement",
        "suffix_agreement",
        "name_missing",
        "email_missing",
        "phone_missing",
        "employer_missing",
        "geography_missing",
        "suffix_conflict",
        "full_middle_conflict",
        "employer_conflict",
        "geography_conflict",
    )
    query = CaseQuery(name="Robin James Taylor Jr.", email="same@example.invalid")
    candidate = RawCandidate(
        name="Robin Joseph Taylor Sr.",
        email=query.email,
        provider_source="SYNTHETIC",
        provider_record_id="opaque",
        provenance_summary="Synthetic test",
    )
    row = extract(query, candidate)
    assert len(row) == len(FEATURES) == 19
    assert row == extract(
        query.model_copy(deep=True),
        candidate.model_copy(
            update={
                "provider_record_id": "person-test-scenario-truth",
                "provider_source": "UNKNOWN",
            }
        ),
    )
    assert row[FEATURES.index("suffix_conflict")] == 1
    assert row[FEATURES.index("full_middle_conflict")] == 1
    assert all(0 <= v <= 1 for v in row)
    assert not any(
        any(token in name for token in ("truth", "scenario", "split", "record_id", "total_score"))
        for name in FEATURES
    )


def test_label_metadata_changes_cannot_change_features(
    data: Dataset, batches: dict[str, Pairs]
) -> None:
    relabeled = replace(
        data,
        labels={
            rid: replace(label, truth_id="same", group_id="changed", scenarios=("changed",))
            for rid, label in data.labels.items()
        },
    )
    changed = build_pairs(relabeled, "validation")
    assert np.array_equal(changed.x, batches["validation"].x)
    assert np.all(changed.y == 1)
    assert not np.array_equal(changed.y, batches["validation"].y)


def test_pair_labels_candidate_sets_and_group_isolation(
    data: Dataset, batches: dict[str, Pairs]
) -> None:
    from benchmarks.identity_resolution.evaluate import partition

    groups, truths = {}, {}
    for split, pairs in batches.items():
        audit_partition(data, pairs, pairs.split)
        groups[split] = {data.labels[rid].group_id for pair in pairs.ids for rid in pair}
        truths[split] = {data.labels[rid].truth_id for pair in pairs.ids for rid in pair}
        _, retriever = partition(data, pairs.split)
        for query in pairs.queries:
            assert [cid for qid, cid in pairs.ids if qid == query.record_id] == retriever.search(
                query, pairs.split
            )
        assert pairs.y.tolist() == [
            int(data.labels[q].truth_id == data.labels[c].truth_id) for q, c in pairs.ids
        ]
    for a, b in (("train", "validation"), ("train", "test"), ("validation", "test")):
        assert groups[a].isdisjoint(groups[b]) and truths[a].isdisjoint(truths[b])


def test_fit_rejects_non_train_and_cross_partition_pairs(
    data: Dataset, batches: dict[str, Pairs]
) -> None:
    for split in ("validation", "test"):
        with pytest.raises(ValueError, match="partition"):
            fit_logistic(data, batches[split], 1, None)
    train = batches["train"]
    poisoned = replace(train, ids=(batches["test"].ids[0], *train.ids[1:]))
    with pytest.raises(ValueError, match="partition"):
        fit_logistic(data, poisoned, 1, None)


def test_scaler_train_only_and_repeat_logical_training(
    data: Dataset, batches: dict[str, Pairs]
) -> None:
    train, validation = batches["train"], batches["validation"]
    a, b = (fit_logistic(data, train, 1, None) for _ in range(2))
    scaler = a.named_steps["scaler"]
    assert scaler.n_samples_seen_ == len(train.y)
    assert np.allclose(scaler.mean_, train.x.mean(axis=0))
    before = scaler.mean_.copy()
    scores_a, scores_b = a.predict_proba(validation.x)[:, 1], b.predict_proba(validation.x)[:, 1]
    assert np.array_equal(before, scaler.mean_)
    assert np.allclose(scores_a, scores_b)
    assert report(data, validation, scores_a) == report(data, validation, scores_b)
    # A changed held-out matrix cannot affect training or preprocessing.
    poisoned_test = replace(batches["test"], x=np.full_like(batches["test"].x, 1000))
    a.predict_proba(poisoned_test.x)
    assert np.array_equal(before, scaler.mean_)


def test_ties_scores_and_contradiction_order() -> None:
    assert order(["z", "a", "blocked"], [0.5, 0.5, 1], [False, False, True], False) == [2, 1, 0]
    assert order(["z", "a", "blocked"], [0.5, 0.5, 1], [False, False, True], True) == [1, 0, 2]
    with pytest.raises(ValueError):
        order(["a"], [float("nan")], [False], True)


def test_high_score_jr_sr_cannot_bypass_gate(data: Dataset, batches: dict[str, Pairs]) -> None:
    pairs = batches["validation"]
    blocked_false = pairs.blocked & (pairs.y == 0)
    assert blocked_false.any()
    assert any(
        "jr_sr" in data.labels[qid].scenarios
        for i, (qid, _) in enumerate(pairs.ids)
        if blocked_false[i]
    )
    scores = np.where(pairs.blocked, 1.0, 0.1)
    raw, gated = (evaluate_scores(data, pairs, scores, gate) for gate in (False, True))
    assert raw["pair_metrics"]["0.99"]["blocked_false_matches"] > 0
    assert gated["pair_metrics"]["0.99"]["blocked_false_matches"] == 0
    assert gated["safety"]["blocked_wrong_top1"] == 0
    assert raw["safety"]["blocked_wrong_top1"] > 0
    # Contradicted records remain in ranking/analysis, rather than disappearing.
    assert raw["ranking"]["candidate_set_size"] == gated["ranking"]["candidate_set_size"]


def test_absent_candidates_and_no_match_denominators(
    data: Dataset, batches: dict[str, Pairs]
) -> None:
    result = ranking_summary([(False, 2, 3), (False, None, 0), (True, None, 4)])
    assert result["recall"] == {"at_1": 0, "at_5": 0.5, "at_10": 0.5}
    assert result["conditional_recall"] == {"at_1": 0, "at_5": 1, "at_10": 1}
    assert result["candidate_generation_misses"] == 1
    assert result["mrr"] == 0.25 and result["conditional_mrr"] == 0.5
    pairs = batches["validation"]
    result = evaluate_scores(data, pairs, pairs.deterministic_scores, True)
    assert result["no_match_top_scores"]["count"] == 3
    assert result["ranking"]["eligible_query_count"] == 131
    assert result["ranking"]["candidate_generation_misses"] == 3


def test_xgboost_optional_import_and_cpu_repeat(
    data: Dataset, batches: dict[str, Pairs], monkeypatch: pytest.MonkeyPatch
) -> None:
    original = builtins.__import__

    def guarded(name: str, *args: object, **kwargs: object):  # type: ignore[no-untyped-def]
        if name.startswith(("xgboost", "torch", "sentence_transformers")):
            pytest.fail("Module import loaded optional ML/embedding packages")
        return original(name, *args, **kwargs)

    with monkeypatch.context() as context:
        context.setattr(builtins, "__import__", guarded)
        importlib.reload(importlib.import_module("benchmarks.identity_resolution.learned_ranking"))
    pytest.importorskip("xgboost")
    train, validation = batches["train"], batches["validation"]
    a, b = (fit_xgboost(data, train, validation) for _ in range(2))
    assert a.get_params()["device"] == "cpu"
    assert np.allclose(a.predict_proba(validation.x), b.predict_proba(validation.x))
    assert report(data, validation, a.predict_proba(validation.x)[:, 1]) == report(
        data, validation, b.predict_proba(validation.x)[:, 1]
    )
    with pytest.raises(ValueError):
        fit_xgboost(data, train, batches["test"])


def test_artifact_schema_and_selection_scope() -> None:
    root = Path(__file__).resolve().parents[1] / "benchmarks/identity_resolution/results/c3"
    manifest = json.loads((root / "manifest.json").read_text())
    assert manifest["feature_schema"] == SCHEMA
    assert manifest["feature_order"] == list(FEATURES)
    assert manifest["aggregate_score_feature"] is False
    selection = json.loads((root / "selection.json").read_text())
    assert selection["selection_split"] == "validation"
    assert selection["held_out_used_for_selection"] is False
    audit = json.loads((root / "feature-investigation.json").read_text())
    assert set(audit) == {"logistic", "xgboost"}
    assert all("validation-only" in v["scope"] for v in audit.values())
    if selection["feature_audit_veto"]:
        assert selection["selected"] == "deterministic"
        assert all(
            v["missing_field_only_win_count"] == v["recovered_count"] for v in audit.values()
        )
    for name in ("logistic", "xgboost"):
        params = json.loads((root / f"{name}-parameters.json").read_text())
        assert params["fit_split"] == "train" and params["feature_order"] == list(FEATURES)
    baseline = json.loads((root / "deterministic-validation.json").read_text())
    assert not survives(baseline, baseline)
    assert selection_key(baseline) == selection_key(baseline)
