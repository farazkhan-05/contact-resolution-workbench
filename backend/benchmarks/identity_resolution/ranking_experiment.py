"""Manual offline ranking experiment; configuration selection precedes test construction."""

import argparse
import json
import platform
import statistics
import time
from dataclasses import replace
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any

import numpy as np
from threadpoolctl import threadpool_limits

from benchmarks.identity_resolution.dataset import SPLITS, Dataset, generate
from benchmarks.identity_resolution.evaluate import (
    evaluate,
    measure_latency,
    partition,
    percentile95,
)
from benchmarks.identity_resolution.learned_ranking import (
    FEATURES,
    SCHEMA,
    SEED,
    Pairs,
    build_pairs,
    comparison,
    distribution,
    evaluate_scores,
    extract,
    fit_logistic,
    fit_xgboost,
    order,
)

RESULTS = Path(__file__).resolve().parent / "results"


def write(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, sort_keys=True, indent=2) + "\n", encoding="utf-8")


def report(data: Dataset, pairs: Pairs, scores: Any) -> dict[str, Any]:
    raw = evaluate_scores(data, pairs, scores, False)
    gated = evaluate_scores(data, pairs, scores, True)
    baseline = evaluate_scores(data, pairs, pairs.deterministic_scores, True)
    paired = comparison(data, pairs, baseline, gated)
    for result in (raw, gated):
        del result["top1_correct_by_query"]
    return {
        "split": pairs.split,
        "balance": pairs.balance(),
        "raw": raw,
        "contradiction_aware": gated,
        "paired_top1_vs_c1": paired,
    }


def compact(result: dict[str, Any]) -> dict[str, Any]:
    """Keep search/ablation summaries small; selected results retain all scenarios."""
    return {
        mode: {k: v for k, v in result[mode].items() if k != "scenario_metrics"}
        for mode in ("raw", "contradiction_aware")
    } | {"paired_top1_vs_c1": result["paired_top1_vs_c1"], "balance": result["balance"]}


def selection_key(result: dict[str, Any]) -> tuple[float, float, float]:
    gated = result["contradiction_aware"]
    # Ranking/safety first; fixed 0.9 FP diagnostic breaks otherwise equal configurations.
    return (
        -gated["safety"]["wrong_identity_top1"],
        gated["ranking"]["mrr"],
        -gated["pair_metrics"]["0.9"]["fp"],
    )


def survives(baseline: dict[str, Any], candidate: dict[str, Any]) -> bool:
    base = baseline["contradiction_aware"]
    gated = candidate["contradiction_aware"]
    return bool(
        candidate["paired_top1_vs_c1"]["all"]["wins"]
        - candidate["paired_top1_vs_c1"]["all"]["losses"]
        >= 2
        and gated["ranking"]["mrr"] > base["ranking"]["mrr"]
        and candidate["raw"]["safety"]["wrong_identity_top1"]
        <= base["safety"]["wrong_identity_top1"]
        and gated["safety"]["unblocked_wrong_top1"] <= base["safety"]["unblocked_wrong_top1"]
    )


def investigate_features(
    data: Dataset,
    train: Pairs,
    validation: Pairs,
    model: Any,
    config: dict[str, Any],
    run_ablations: bool = True,
) -> dict[str, Any]:
    """Validation acceptance audit, never a search for a replacement feature set."""
    ablations = {}
    for name, masked in (
        ("without_missing_indicators", [f for f in FEATURES if f.endswith("_missing")]),
        ("without_geography", [f for f in FEATURES if f.startswith("geography")]),
        (
            "name_contacts_contradictions",
            [
                f
                for f in FEATURES
                if f.endswith("_missing") or f.startswith(("employer", "geography"))
            ],
        ),
    ):
        if not run_ablations:
            break
        columns = [FEATURES.index(f) for f in masked]
        tx, vx = train.x.copy(), validation.x.copy()
        tx[:, columns], vx[:, columns] = 0, 0
        diagnostic = fit_logistic(data, replace(train, x=tx), config["C"], config["class_weight"])
        ablations[name] = {
            "masked_features": masked,
            "validation": compact(
                report(data, replace(validation, x=vx), diagnostic.predict_proba(vx)[:, 1])
            ),
        }
    baseline = evaluate_scores(data, validation, validation.deterministic_scores, True)
    scores = model.predict_proba(validation.x)[:, 1]
    learned = evaluate_scores(data, validation, scores, True)
    effects = {
        "name_missing": {
            "name_component",
            "full_name_similarity",
            "first_name_similarity",
            "last_name_similarity",
        },
        "email_missing": {"email_exact"},
        "phone_missing": {"phone_exact"},
        "employer_missing": {"employer_component", "employer_conflict"},
        "geography_missing": {"geography_component", "geography_conflict"},
    }
    recovered = []
    for query in validation.queries:
        qid = query.record_id
        if not learned["top1_correct_by_query"][qid] or baseline["top1_correct_by_query"][qid]:
            continue
        rows = [i for i, (row_qid, _) in enumerate(validation.ids) if row_qid == qid]
        ranked = [
            rows[i]
            for i in order(
                [validation.ids[i][1] for i in rows], scores[rows], validation.blocked[rows], True
            )
        ]
        top = ranked[0]
        negative = next(i for i in ranked if not validation.y[i])
        differences = {
            f for j, f in enumerate(FEATURES) if validation.x[top, j] != validation.x[negative, j]
        }
        availability_effects = set()
        for indicator, affected in effects.items():
            if indicator in differences:
                availability_effects.update({indicator, *affected})
        recovered.append(
            {
                "query_id": qid,
                "feature_differences": sorted(differences),
                "only_missing_field_effects": bool(
                    differences and differences <= availability_effects
                ),
            }
        )
    return {
        "scope": "Train-only fits, validation-only diagnostics; no test scoring or retuning.",
        "ablations": ablations,
        "recovered_validation_queries": recovered,
        "recovered_count": len(recovered),
        "missing_field_only_win_count": sum(r["only_missing_field_effects"] for r in recovered),
        "train_feature_class_means": {
            f: {
                "positive": float(train.x[train.y == 1, j].mean()),
                "negative": float(train.x[train.y == 0, j].mean()),
            }
            for j, f in enumerate(FEATURES)
        },
    }


def timing(data: Dataset, pairs: Pairs, model: Any) -> dict[str, object]:
    queries, retriever = partition(data, pairs.split)
    grouped: dict[str, list[int]] = {q.record_id: [] for q in queries}
    for i, (qid, _) in enumerate(pairs.ids):
        grouped[qid].append(i)
    samples: dict[str, list[float]] = {
        s: [] for s in ("feature_extraction", "model_scoring", "ranking")
    }
    for repeat in range(6):
        for query in queries:
            indices = grouped[query.record_id]
            if not indices:
                continue
            ids = [pairs.ids[i][1] for i in indices]
            start = time.perf_counter_ns()
            x = np.asarray([extract(query.profile, retriever.records[cid]) for cid in ids])
            extracted = time.perf_counter_ns()
            scores = model.predict_proba(x)[:, 1]
            scored = time.perf_counter_ns()
            order(ids, scores, pairs.blocked[indices], True)
            ranked = time.perf_counter_ns()
            if repeat:
                for component, elapsed in zip(
                    samples, (extracted - start, scored - extracted, ranked - scored), strict=True
                ):
                    samples[component].append(elapsed / 1_000_000)
    return {
        component: {
            "median_ms": statistics.median(values),
            "p95_ms": percentile95(values),
            "calls": len(values),
        }
        for component, values in samples.items()
    }


def run(output: Path, challenger: bool, held_out: bool) -> None:
    data = generate()
    if data.manifest() != json.loads((RESULTS / "manifest.json").read_text()):
        raise ValueError("C3 requires the unchanged frozen C1 manifest")
    # C1 recomputation is independent verification; it does not select configurations.
    for split in SPLITS:
        if evaluate(data, split) != json.loads((RESULTS / f"{split}.json").read_text()):
            raise ValueError("C1 logical results drifted")
    train, validation = build_pairs(data, "train"), build_pairs(data, "validation")
    development = {"train": train, "validation": validation}
    baseline_validation = report(data, validation, validation.deterministic_scores)
    search = []
    models: dict[str, Any] = {}
    configs: dict[str, dict[str, Any]] = {}
    timings: dict[str, object] = {}
    best_key = None
    for c in (0.1, 1.0, 10.0):
        for weight in (None, "balanced"):
            start = time.perf_counter()
            model = fit_logistic(data, train, c, weight)
            elapsed = time.perf_counter() - start
            result = report(data, validation, model.predict_proba(validation.x)[:, 1])
            key = selection_key(result)
            config = {
                "C": c,
                "class_weight": weight,
                "solver": "lbfgs",
                "max_iter": 2000,
                "regularization": "L2",
                "random_state": SEED,
                "preprocessing": "StandardScaler, train only",
            }
            search.append({"configuration": config, "validation": compact(result)})
            if best_key is None or key > best_key:
                best_key = key
                models["logistic"] = model
                configs["logistic"] = config
                timings["logistic_training_seconds"] = elapsed
    write(output / "logistic-validation-search.json", {"feature_schema": SCHEMA, "search": search})
    evaluations: dict[str, dict[str, Any]] = {}
    for name, model in models.items():
        evaluations[name] = {
            s: report(data, pairs, model.predict_proba(pairs.x)[:, 1])
            for s, pairs in development.items()
        }
    if challenger:
        start = time.perf_counter()
        model = fit_xgboost(data, train, validation)
        timings["xgboost_training_seconds"] = time.perf_counter() - start
        models["xgboost"] = model
        configs["xgboost"] = {
            k: model.get_params()[k]
            for k in (
                "objective",
                "device",
                "tree_method",
                "n_jobs",
                "random_state",
                "max_depth",
                "n_estimators",
                "learning_rate",
                "min_child_weight",
                "reg_lambda",
                "reg_alpha",
                "subsample",
                "colsample_bytree",
                "scale_pos_weight",
                "eval_metric",
                "early_stopping_rounds",
                "importance_type",
            )
        }
        configs["xgboost"]["best_iteration"] = model.best_iteration
        evaluations["xgboost"] = {
            s: report(data, pairs, model.predict_proba(pairs.x)[:, 1])
            for s, pairs in development.items()
        }
    chosen = "deterministic"
    if survives(baseline_validation, evaluations["logistic"]["validation"]):
        chosen = "logistic"
    if challenger and survives(baseline_validation, evaluations["xgboost"]["validation"]):
        lr = evaluations["logistic"]["validation"]["contradiction_aware"]
        xgb = evaluations["xgboost"]["validation"]["contradiction_aware"]
        # Prefer LR unless nonlinear ranking improves at least two additional queries,
        # with MRR and both fixed high-score false-positive probes no worse.
        if chosen == "deterministic" or (
            xgb["safety"]["wrong_identity_top1"] <= lr["safety"]["wrong_identity_top1"] - 2
            and xgb["ranking"]["mrr"] > lr["ranking"]["mrr"]
            and all(
                xgb["pair_metrics"][t]["fp"] <= lr["pair_metrics"][t]["fp"] for t in ("0.9", "0.99")
            )
        ):
            chosen = "xgboost"
    investigation = investigate_features(
        data, train, validation, models["logistic"], configs["logistic"]
    )
    investigations = {"logistic": investigation}
    if challenger:
        investigations["xgboost"] = investigate_features(
            data, train, validation, models["xgboost"], configs["logistic"], run_ablations=False
        )
    write(output / "feature-investigation.json", investigations)
    metric_selected = chosen
    # C1 intentionally uses asymmetric partial observations. A numeric win wholly
    # explained by those omissions is insufficient evidence for accepting a ranker.
    artifact_veto = bool(
        all(
            audit["recovered_count"]
            and audit["missing_field_only_win_count"] == audit["recovered_count"]
            for audit in investigations.values()
        )
    )
    if artifact_veto:
        chosen = "deterministic"
    selection = {
        "selected": chosen,
        "metric_selected_before_feature_audit": metric_selected,
        "feature_audit_veto": artifact_veto,
        "acceptance_reason": (
            "All recovered validation queries separate the top true and best false observation "
            "only through missing-field effects. C1's asymmetric partial-observation construction "
            "is an accidental predictive pattern, not defensible identity evidence. Reject both "
            "learned rankers; preserve their measured results without retuning the benchmark."
            if artifact_veto
            else "Numeric selection survived the validation feature audit."
        ),
        "selection_split": "validation",
        "configurations": configs,
        "rule": (
            "Require >=2 net validation top1 wins, better MRR, no increase in raw or gated "
            "wrong top1. Prefer LR unless XGB adds >=2 wins with better MRR and no worse "
            "FP at 0.9/0.99."
        ),
        "held_out_used_for_selection": False,
        "production_integration": False,
    }
    # This artifact is written BEFORE any held-out feature matrix/model scoring exists.
    write(output / "selection.json", selection)
    batches: dict[str, Pairs] = dict(development)
    if held_out:
        batches["test"] = build_pairs(data, "test")
        for name, model in models.items():
            evaluations[name]["test"] = report(
                data, batches["test"], model.predict_proba(batches["test"].x)[:, 1]
            )
    versions = {
        p: version(p)
        for p in (
            "scikit-learn",
            "numpy",
            "scipy",
            "joblib",
            "threadpoolctl",
            "narwhals",
            "cloudpickle",
        )
    }
    if challenger:
        try:
            versions["xgboost"] = version("xgboost")
        except PackageNotFoundError:
            versions["xgboost-cpu"] = version("xgboost-cpu")
    metadata = {
        "benchmark_version": data.manifest()["version"],
        "dataset_sha256": data.manifest()["sha256"],
        "feature_schema": SCHEMA,
        "feature_order": FEATURES,
        "aggregate_score_feature": False,
        "versions": versions,
        "class_balance": {s: p.balance() for s, p in batches.items()},
        "fit_split": "train",
        "selection_split": "validation",
        "seed": SEED,
        "persistence": (
            "Own fitted LR parameters/scaler in JSON; XGB importance/config plus reproducible "
            "retraining. No pickle or runtime loader."
        ),
        "pair_threshold_scope": (
            "Fixed diagnostic probes 0.5/0.9/0.99; model scores are uncalibrated, "
            "no production thresholds."
        ),
    }
    write(output / "manifest.json", metadata)
    for s, pairs in batches.items():
        write(output / f"deterministic-{s}.json", report(data, pairs, pairs.deterministic_scores))
    for name, results in evaluations.items():
        for s, result in results.items():
            write(output / f"{name}-{s}.json", result)
        model = models[name]
        if name == "logistic":
            scaler, classifier = model.named_steps["scaler"], model.named_steps["classifier"]
            explanation = {
                "standardized_coefficients": dict(
                    zip(FEATURES, classifier.coef_[0].tolist(), strict=True)
                ),
                "intercept": classifier.intercept_.tolist(),
                "scaler_mean": scaler.mean_.tolist(),
                "scaler_scale": scaler.scale_.tolist(),
                "scaler_train_samples": int(scaler.n_samples_seen_),
            }
        else:
            explanation = {
                "normalized_gain_importance": dict(
                    zip(FEATURES, model.feature_importances_.tolist(), strict=True)
                )
            }
        write(
            output / f"{name}-parameters.json",
            metadata | {"model_type": name, "configuration": configs[name], **explanation},
        )
        for s, pairs in batches.items():
            timings[f"{name}-{s}"] = timing(data, pairs, model)
    # Validation-only distributions for later C4 exploration; no threshold selection.
    distributions = {}
    for name, model in models.items():
        scores = model.predict_proba(validation.x)[:, 1]
        no_match_ids = {
            q.record_id for q in validation.queries if data.labels[q.record_id].no_correct_candidate
        }
        distributions[name] = {
            "true_pairs": distribution(scores[validation.y == 1]),
            "false_pairs": distribution(scores[validation.y == 0]),
            "contradicted_pairs": distribution(scores[validation.blocked]),
            "no_match_pairs": distribution(
                [
                    float(scores[i])
                    for i, (qid, _) in enumerate(validation.ids)
                    if qid in no_match_ids
                ]
            ),
        }
    write(output / "validation-score-distributions.json", distributions)
    timings["environment"] = {
        "python": platform.python_version(),
        "system": platform.system(),
        "machine": platform.machine(),
        "processor": platform.processor(),
        "versions": versions,
        "threads": 1,
    }
    timings["scope"] = (
        "Local warm query batches, five passes after warmup; features/scoring/order separate, "
        "retrieval excluded. C1 timing includes normalization/blocking/order. "
        "Not production latency."
    )
    timings["deterministic"] = {
        s: measure_latency(data, pairs.split) for s, pairs in batches.items()
    }
    write(output / "latency.json", timings)
    print(
        json.dumps(
            {
                "selection": selection,
                "balance": metadata["class_balance"],
                "ranking": {
                    n: {s: r["contradiction_aware"]["ranking"] for s, r in rs.items()}
                    for n, rs in evaluations.items()
                },
            },
            indent=2,
        )
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--challenger", action="store_true")
    parser.add_argument("--held-out", action="store_true")
    parser.add_argument("--output", type=Path, default=RESULTS / "c3")
    args = parser.parse_args()
    with threadpool_limits(limits=1):
        run(args.output, args.challenger, args.held_out)


if __name__ == "__main__":
    main()
