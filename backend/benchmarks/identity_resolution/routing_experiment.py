"""C4 offline experiment. Develop and freeze before explicitly opening held-out test."""

import argparse
import hashlib
import json
from dataclasses import asdict
from pathlib import Path
from typing import Any, cast

from app.schemas.resolution import CaseQuery
from app.services.fixtures import BENCHMARK_CASES
from app.services.resolution_service import ResolutionService
from benchmarks.identity_resolution.dataset import VERSION, Dataset, generate
from benchmarks.identity_resolution.evaluate import evaluate
from benchmarks.identity_resolution.routing import (
    CURRENT,
    POLICY_VERSION,
    Policy,
    adversarial_gates,
    build_cases,
    changed_cases,
    compact_metrics,
    distributions,
    gate_audit,
    margin_audit,
    metrics,
    neighborhood,
    report,
    select_policy,
)

RESULTS = Path(__file__).resolve().parent / "results"
GRID = tuple(
    Policy(likely, review) for likely in (65, 70, 75, 80, 85) for review in (40, 45, 50, 55)
)
DECISION = (
    "C: retain 75/45 and require future real-data calibration. Current validation already "
    "has zero observed unsafe automatic matches. The numeric 70/40 winner adds only one "
    "automatic transliteration match (zero name points), and four review cases, three "
    "in missing_fields. This small synthetic gain is insufficient for adoption. The "
    "auto gain is not the C3 asymmetric omission artifact; weak/missing-field review "
    "gains still cannot establish reliable identity. No production thresholds change."
)


def write(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, sort_keys=True, indent=2) + "\n", encoding="utf-8")


def frozen_integrity(data: Dataset) -> dict[str, str]:
    """Refuse changed C1 data/logical metrics; hash all pre-C4 results, including C2/C3."""
    manifest = json.loads((RESULTS / "manifest.json").read_text(encoding="utf-8"))
    if data.manifest() != manifest:
        raise ValueError("Frozen C1 manifest changed; stop before evaluating routing")
    for split in ("train", "validation", "test"):
        expected = json.loads((RESULTS / f"{split}.json").read_text(encoding="utf-8"))
        if evaluate(data, split) != expected:
            raise ValueError("Frozen C1 retrieval changed; stop before evaluating routing")
    return {
        str(path.relative_to(RESULTS)).replace("\\", "/"): hashlib.sha256(
            path.read_bytes()
        ).hexdigest()
        for path in sorted(RESULTS.rglob("*.json"))
        if "c4" not in path.relative_to(RESULTS).parts
    }


def develop(data: Dataset) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    train = build_cases(data, "train")
    validation = build_cases(data, "validation")
    numeric, search = select_policy(train, validation, GRID)
    selection = {
        "benchmark_version": VERSION,
        "policy_version": POLICY_VERSION,
        "dataset_sha256": data.manifest()["sha256"],
        "current_production": asdict(CURRENT),
        "numeric_validation_winner": asdict(numeric),
        "best_zero_observed_unsafe_validation": asdict(numeric),
        "frozen_policy": asdict(CURRENT),
        "production_changed": False,
        "primary_outcome": "C",
        "decision": DECISION,
        "selection_splits": ["train", "validation"],
        "lexicographic_objective": [
            "minimize validation unsafe_auto",
            "maximize validation safe_auto",
            "minimize false_no_match_corpus (review is acceptable, not labeled unnecessary)",
            "minimize threshold distance from production",
            "stable numeric threshold order",
        ],
        "held_out_not_used_for_selection": True,
        "search": [
            {
                "policy": row["policy"],
                "train": compact_metrics(row["train"]),
                "validation": compact_metrics(row["validation"]),
            }
            for row in search
        ],
    }
    analysis = {
        "adversarial_gates": adversarial_gates(),
        "production_demo": [
            {
                "case": item["case_number"],
                "score": result.top_score,
                "route": result.routing_status.value,
            }
            for item in BENCHMARK_CASES
            for result in [ResolutionService().resolve(cast(CaseQuery, item["query"]))]
        ],
        "distributions": {"train": distributions(train), "validation": distributions(validation)},
        "validation_changed_cases_numeric_winner": changed_cases(validation, numeric),
        "neighborhood": {
            name: [
                {
                    "policy": asdict(p),
                    "train": compact_metrics(metrics(train, p)),
                    "validation": compact_metrics(metrics(validation, p)),
                }
                for p in neighborhood(policy)
            ]
            for name, policy in (("current", CURRENT), ("numeric_winner", numeric))
        },
        "margin": {"train": margin_audit(train), "validation": margin_audit(validation)},
        "margin_decision": "Do not add margin: baseline unsafe_auto is already zero; a raw "
        "top-two margin confounds repeated observations of the same identity with ambiguity.",
        "missingness_limit": "C3 asymmetric observation omissions remain frozen. No ranking "
        "or missingness feature is tuned. One auto gain has no missing fields; three of four "
        "extra reviews are explicitly missing_fields. These are insufficient adoption evidence.",
    }
    development = {}
    for split, cases in (("train", train), ("validation", validation)):
        development[split] = {
            "baseline": report(cases),
            "numeric_winner": report(cases, numeric),
            "gate_audit": gate_audit(cases),
            "routing_top_differs_from_c1_first": sum(
                c.top != c.candidates[0] for c in cases if c.candidates
            ),
        }
    return selection, analysis, development


def run(output: Path, held_out: bool = False) -> None:
    data = generate()
    integrity = frozen_integrity(data)
    selection, analysis, development = develop(data)
    if held_out:
        # Never rewrite the freeze after opening held-out routing outcomes.
        existing = json.loads((output / "selection.json").read_text(encoding="utf-8"))
        if existing != selection:
            raise ValueError(
                "Run development first; frozen selection must match before held-out evaluation"
            )
        test = build_cases(data, "test")
        numeric = Policy(**selection["numeric_validation_winner"])
        write(
            output / "test.json",
            {
                "baseline_and_frozen_policy": report(test, CURRENT),
                "frozen_numeric_challenger": report(test, numeric),
                "gate_audit": gate_audit(test),
                "policy_frozen_before_test": True,
                "test_used_for_selection": False,
            },
        )
    else:
        write(output / "selection.json", selection)
        write(output / "analysis.json", analysis)
        for split, value in development.items():
            write(output / f"{split}.json", value)
        write(
            output / "manifest.json",
            {
                "benchmark_version": VERSION,
                "policy_version": POLICY_VERSION,
                "dataset_manifest": data.manifest(),
                "pre_c4_artifact_sha256": integrity,
                "routing_semantics": "Production max-score router on unchanged C1 "
                "blocked/score/ID input. Ties retain first C1 candidate. C1 rank order is "
                "not rewritten; report actual router selection.",
                "rates": "wrong/unsafe per_auto use all LIKELY_MATCH; per_query use all queries. "
                "False no-match reports both full-corpus and retrieved-true denominators. "
                "NO_RELIABLE_MATCH of a corpus-true query is an identity rejection diagnostic, "
                "not proof the policy should force an automatic match.",
                "contradiction_counts": "Query prevention counts require the selected top "
                "to be blocked. Isolated pair gates are counterfactual opportunities, "
                "not additional prevented merges.",
            },
        )
    print(
        json.dumps(
            {"held_out": held_out, "policy": selection["frozen_policy"], "decision": DECISION}
        )
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Offline contradiction-aware routing evaluation")
    parser.add_argument("--output", type=Path, default=RESULTS / "c4")
    parser.add_argument("--held-out", action="store_true")
    args = parser.parse_args()
    run(args.output, args.held_out)


if __name__ == "__main__":
    main()
