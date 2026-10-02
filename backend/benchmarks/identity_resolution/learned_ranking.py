"""Offline C3: structured pair scoring on the frozen C1 candidate sets.

Product profiles alone enter extraction. Labels/IDs stay in evaluation bookkeeping.
No runtime module imports this experiment, and XGBoost is imported only on request.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np
from numpy.typing import NDArray
from rapidfuzz import fuzz
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    average_precision_score,
    confusion_matrix,
    precision_recall_fscore_support,
)
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from app.schemas.resolution import CaseQuery, RawCandidate
from app.services.contradiction import evaluate_contradictions
from app.services.matcher import calculate_total_score, score_candidate
from app.services.normalizer import normalize_name, parse_name_parts
from benchmarks.identity_resolution.dataset import Dataset, FeatureRecord, Split
from benchmarks.identity_resolution.evaluate import partition, summarize

SCHEMA = "c3-structured-components-v1"
SEED = 20261001
FEATURES = (
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
CONFLICTS = (
    "INCOMPATIBLE_NAME_SUFFIX",
    "CONFLICTING_FULL_MIDDLE_NAME",
    "DIFFERING_EMPLOYER",
    "DIFFERING_GEOGRAPHY",
)


def similarity(left: str | None, right: str | None) -> float:
    a, b = normalize_name(left), normalize_name(right)
    return float(fuzz.token_sort_ratio(a, b)) / 100 if a and b else 0.0


def extract(query: CaseQuery, candidate: RawCandidate) -> tuple[float, ...]:
    """19 explicit signals; no aggregate score, contact substrings, or source constants."""
    components = score_candidate(query, candidate)
    left, right = parse_name_parts(query.name), parse_name_parts(candidate.name)
    middle = (
        query.middle_name or left["middle_name"],
        candidate.middle_name or right["middle_name"],
    )
    suffix = (query.name_suffix or left["suffix"], candidate.name_suffix or right["suffix"])
    mids = [normalize_name(v).rstrip(".") for v in middle]
    sufs = [normalize_name(v).rstrip(".") for v in suffix]
    conflicts = {c.contradiction_type for c in evaluate_contradictions(query, candidate)}
    return (
        *(e.points_awarded / e.max_points for e in components),
        similarity(query.name, candidate.name),
        similarity(
            query.first_name or left["first_name"], candidate.first_name or right["first_name"]
        ),
        similarity(query.last_name or left["last_name"], candidate.last_name or right["last_name"]),
        float(bool(mids[0] and mids[1] and mids[0][0] == mids[1][0])),
        float(bool(sufs[0] and sufs[1] and sufs[0] == sufs[1])),
        *(float(e.match_method == "MISSING") for e in components),
        *(float(kind in conflicts) for kind in CONFLICTS),
    )


@dataclass(frozen=True)
class Pairs:
    split: Split
    queries: tuple[FeatureRecord, ...]
    ids: tuple[tuple[str, str], ...]
    x: NDArray[np.float64]
    y: NDArray[np.int64]
    blocked: NDArray[np.bool_]
    deterministic_scores: NDArray[np.float64]

    def balance(self) -> dict[str, int | float]:
        positive = int(self.y.sum())
        negative = len(self.y) - positive
        return {
            "pairs": len(self.y),
            "positive": positive,
            "negative": negative,
            "negative_per_positive": negative / positive if positive else 0.0,
        }


def build_pairs(data: Dataset, split: Split) -> Pairs:
    queries, retriever = partition(data, split)
    ids, rows, labels, blocked, scores = [], [], [], [], []
    for query in queries:
        for cid in retriever.search(query, split):
            candidate = retriever.records[cid]
            ids.append((query.record_id, cid))
            rows.append(extract(query.profile, candidate))
            labels.append(int(data.labels[query.record_id].truth_id == data.labels[cid].truth_id))
            blocked.append(
                any(
                    c.blocks_likely_match for c in evaluate_contradictions(query.profile, candidate)
                )
            )
            scores.append(calculate_total_score(score_candidate(query.profile, candidate)) / 100)
    pairs = Pairs(
        split,
        queries,
        tuple(ids),
        np.asarray(rows, dtype=np.float64).reshape(-1, len(FEATURES)),
        np.asarray(labels, dtype=np.int64),
        np.asarray(blocked, dtype=np.bool_),
        np.asarray(scores, dtype=np.float64),
    )
    audit_partition(data, pairs, split)
    return pairs


def audit_partition(data: Dataset, pairs: Pairs, expected: Split) -> None:
    if pairs.split != expected or any(
        data.labels[q.record_id].split != expected for q in pairs.queries
    ):
        raise ValueError("Incorrect query partition")
    if any(data.labels[rid].split != expected for pair in pairs.ids for rid in pair):
        raise ValueError("Cross-partition candidate pair")
    if pairs.x.shape != (len(pairs.ids), len(FEATURES)):
        raise ValueError("Feature schema mismatch")


def fit_logistic(data: Dataset, train: Pairs, c: float, weight: str | None) -> Pipeline:
    audit_partition(data, train, "train")
    model = Pipeline(
        [
            ("scaler", StandardScaler()),
            (
                "classifier",
                LogisticRegression(
                    C=c, class_weight=weight, solver="lbfgs", max_iter=2000, random_state=SEED
                ),
            ),
        ]
    )
    model.fit(train.x, train.y)
    return model


def fit_xgboost(data: Dataset, train: Pairs, validation: Pairs) -> Any:
    audit_partition(data, train, "train")
    audit_partition(data, validation, "validation")
    from xgboost import XGBClassifier

    # Imbalance is modest; use an unweighted challenger, not a second tuning search.
    model = XGBClassifier(
        objective="binary:logistic",
        device="cpu",
        tree_method="hist",
        n_jobs=1,
        random_state=SEED,
        max_depth=3,
        n_estimators=200,
        learning_rate=0.05,
        min_child_weight=5,
        reg_lambda=5,
        reg_alpha=0.1,
        subsample=1.0,
        colsample_bytree=1.0,
        scale_pos_weight=1.0,
        eval_metric="logloss",
        early_stopping_rounds=20,
        importance_type="gain",
    )
    model.fit(train.x, train.y, eval_set=[(validation.x, validation.y)], verbose=False)
    return model


def order(
    ids: Sequence[str],
    scores: Sequence[float] | NDArray[np.float64],
    blocked: Sequence[bool] | NDArray[np.bool_],
    gated: bool,
) -> list[int]:
    if not (len(ids) == len(scores) == len(blocked)) or not np.isfinite(scores).all():
        raise ValueError("Invalid candidate scores")
    return sorted(
        range(len(ids)), key=lambda i: (bool(blocked[i]) if gated else False, -scores[i], ids[i])
    )


def distribution(values: Sequence[float]) -> dict[str, float | int | None]:
    return {
        "count": len(values),
        **{
            name: float(np.quantile(values, q)) if len(values) else None
            for name, q in (("min", 0), ("median", 0.5), ("p95", 0.95), ("max", 1))
        },
    }


def ranking_summary(outcomes: Sequence[tuple[bool, int | None, int]]) -> dict[str, object]:
    result = summarize(outcomes)
    eligible = [rank for no_match, rank, _ in outcomes if not no_match]
    available = [rank for rank in eligible if rank is not None]
    result["mrr"] = sum(1 / r for r in available) / len(eligible) if eligible else None
    result["candidate_generation_misses"] = len(eligible) - len(available)
    result["available_candidate_queries"] = len(available)
    result["ranking_failures_at_1"] = sum(r > 1 for r in available)
    result["conditional_recall"] = {
        f"at_{k}": sum(r <= k for r in available) / len(available) if available else None
        for k in (1, 5, 10)
    }
    result["conditional_mrr"] = (
        sum(1 / r for r in available) / len(available) if available else None
    )
    return result


def evaluate_scores(
    data: Dataset, pairs: Pairs, scores: NDArray[np.float64], gated: bool
) -> dict[str, Any]:
    if scores.shape != pairs.y.shape or not np.isfinite(scores).all():
        raise ValueError("Invalid score matrix")
    indices: dict[str, list[int]] = {q.record_id: [] for q in pairs.queries}
    for i, (qid, _) in enumerate(pairs.ids):
        indices[qid].append(i)
    outcomes, no_match_tops = [], []
    scenarios: dict[str, list[tuple[bool, int | None, int]]] = {}
    wrong = blocked_wrong = unsafe_wrong = no_match_safe_top = all_blocked = 0
    top_truth: dict[str, bool] = {}
    for query in pairs.queries:
        label = data.labels[query.record_id]
        rows = indices[query.record_id]
        ranked = [
            rows[i]
            for i in order(
                [pairs.ids[i][1] for i in rows], scores[rows], pairs.blocked[rows], gated
            )
        ]
        rank = next((j for j, i in enumerate(ranked, 1) if pairs.y[i]), None)
        outcome = label.no_correct_candidate, rank, len(rows)
        outcomes.append(outcome)
        top_truth[query.record_id] = bool(rank == 1)
        for scenario in label.scenarios:
            scenarios.setdefault(scenario, []).append(outcome)
        if ranked:
            top = ranked[0]
            safe = not pairs.blocked[top]
            all_blocked += not any(not pairs.blocked[i] for i in ranked)
            if label.no_correct_candidate:
                no_match_tops.append(float(scores[top]))
                no_match_safe_top += safe
            elif not pairs.y[top]:
                wrong += 1
                blocked_wrong += bool(pairs.blocked[top])
                unsafe_wrong += safe
    # Thresholds are fixed diagnostic probes, never production routing choices.
    thresholds = {}
    for threshold in (0.5, 0.9, 0.99):
        predicted = scores >= threshold
        if gated:
            predicted &= ~pairs.blocked
        tn, fp, fn, tp = confusion_matrix(pairs.y, predicted, labels=[0, 1]).ravel()
        precision, recall, f1, _ = precision_recall_fscore_support(
            pairs.y, predicted, average="binary", zero_division=0
        )
        thresholds[str(threshold)] = {
            "precision": float(precision),
            "recall": float(recall),
            "f1": float(f1),
            "tn": int(tn),
            "fp": int(fp),
            "fn": int(fn),
            "tp": int(tp),
            "blocked_false_matches": int(np.sum(predicted & pairs.blocked & (pairs.y == 0))),
        }
    return {
        "ranking": ranking_summary(outcomes),
        "safety": {
            "wrong_identity_top1": wrong,
            "blocked_wrong_top1": blocked_wrong,
            "unblocked_wrong_top1": unsafe_wrong,
            "all_candidates_blocked_queries": all_blocked,
            "no_match_unblocked_top_queries": no_match_safe_top,
        },
        "no_match_top_scores": distribution(no_match_tops),
        "pair_metrics": thresholds,
        "average_precision": float(average_precision_score(pairs.y, scores))
        if pairs.y.sum()
        else None,
        "scenario_metrics": {s: ranking_summary(v) for s, v in sorted(scenarios.items())},
        "top1_correct_by_query": top_truth,
    }


def comparison(
    data: Dataset, pairs: Pairs, baseline: dict[str, Any], learned: dict[str, Any]
) -> dict[str, dict[str, int]]:
    counts: dict[str, dict[str, int]] = {}
    for query in pairs.queries:
        label = data.labels[query.record_id]
        if label.no_correct_candidate:
            continue
        before, after = (r["top1_correct_by_query"][query.record_id] for r in (baseline, learned))
        for scenario in ("all", *label.scenarios):
            count = counts.setdefault(scenario, {"wins": 0, "losses": 0})
            count["wins"] += after and not before
            count["losses"] += before and not after
    return counts
