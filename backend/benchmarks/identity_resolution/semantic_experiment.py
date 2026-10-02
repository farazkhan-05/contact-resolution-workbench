"""Explicit manual experiments on frozen C1 data, never invoked by the runtime API."""

import argparse
import json
import platform
import statistics
import tempfile
import time
from collections.abc import Callable
from dataclasses import asdict
from datetime import UTC, datetime
from importlib.metadata import version
from pathlib import Path

from app.services.contradiction import evaluate_contradictions
from benchmarks.identity_resolution.dataset import SPLITS, Dataset, FeatureRecord, Split, generate
from benchmarks.identity_resolution.embedding_providers import GeminiEncoder, LocalEncoder
from benchmarks.identity_resolution.evaluate import Searcher, evaluate, partition, percentile95
from benchmarks.identity_resolution.semantic import (
    GEMINI_MODEL,
    ExactRetriever,
    HybridRetriever,
    serialize,
)

RESULTS = Path("benchmarks/identity_resolution/results")


def write(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, sort_keys=True, indent=2) + "\n", encoding="utf-8")


def safety(
    data: Dataset, queries: tuple[FeatureRecord, ...], retriever: Searcher, split: Split
) -> dict[str, object]:
    wrong, blocked_wrong = 0, 0
    for query in queries:
        label = data.labels[query.record_id]
        ids = retriever.search(query, split)
        if not ids or label.no_correct_candidate:
            continue
        top = ids[0]
        if data.labels[top].truth_id != label.truth_id:
            wrong += 1
            blocked_wrong += any(
                c.blocks_likely_match
                for c in evaluate_contradictions(query.profile, retriever.records[top])
            )
    return {
        "wrong_identity_top1": wrong,
        "wrong_identity_top1_with_serious_contradiction": blocked_wrong,
        "scope": "Eligible queries only. Retrieval diagnostics, not merge decisions.",
    }


def paired_coverage(
    data: Dataset,
    queries: tuple[FeatureRecord, ...],
    baseline: Searcher,
    experiment: Searcher,
    split: Split,
) -> dict[str, object]:
    counters: dict[str, dict[str, int]] = {}
    for query in queries:
        label = data.labels[query.record_id]
        if label.no_correct_candidate:
            continue
        base_ids = baseline.search(query, split)
        experiment_ids = experiment.search(query, split)
        for scenario in ("all", *label.scenarios):
            count = counters.setdefault(scenario, {"eligible_queries": 0})
            count["eligible_queries"] += 1
            for k in (1, 5, 10, 20):
                before = any(data.labels[c].truth_id == label.truth_id for c in base_ids[:k])
                after = any(data.labels[c].truth_id == label.truth_id for c in experiment_ids[:k])
                for name, changed in (
                    ("recovered", after and not before),
                    ("lost", before and not after),
                ):
                    field = f"{name}_at_{k}"
                    count[field] = count.get(field, 0) + changed
    return dict(sorted(counters.items()))


def time_search(
    queries: tuple[FeatureRecord, ...], retriever: Searcher, split: Split
) -> dict[str, object]:
    for query in queries:
        retriever.search(query, split)
    milliseconds = []
    for _ in range(5):
        for query in queries:
            start = time.perf_counter_ns()
            retriever.search(query, split)
            milliseconds.append((time.perf_counter_ns() - start) / 1_000_000)
    return {
        "median_ms": statistics.median(milliseconds),
        "mean_ms": statistics.mean(milliseconds),
        "p95_ms": percentile95(milliseconds),
        "timed_calls": len(milliseconds),
        "repeats": 5,
        "scope": "Warm exact retrieval/order only; embeddings already computed",
    }


def run_partition(
    data: Dataset, split: Split, encoder: LocalEncoder | GeminiEncoder, output: Path
) -> dict[str, object]:
    start = time.perf_counter()
    queries, deterministic = partition(data, split)
    corpus = [c for c in data.candidates if data.labels[c.record_id].split == split]
    qvectors, qtime = encoder.encode([serialize(q.profile) for q in queries], "query")
    cvectors, ctime = encoder.encode([serialize(c.profile) for c in corpus], "document")
    exact = ExactRetriever(
        deterministic,
        [c.record_id for c in corpus],
        cvectors,
        {q.record_id: v for q, v in zip(queries, qvectors, strict=True)},
    )
    hybrid = HybridRetriever(deterministic, exact)
    prefix = "gemini" if isinstance(encoder, GeminiEncoder) else "local"
    manifest = data.manifest()
    environment: dict[str, object] = {
        "python": platform.python_version(),
        "system": platform.system(),
        "machine": platform.machine(),
        "processor": platform.processor(),
        "numpy": version("numpy"),
        "device": "cpu",
    }
    if prefix == "local":
        environment.update(
            {
                "sentence_transformers": version("sentence-transformers"),
                "torch": version("torch"),
                "torch_threads": 2,
            }
        )
    timings: dict[str, object] = {
        "model_loading_seconds": encoder.loading_seconds,
        "query_embeddings": qtime,
        "document_embeddings": ctime,
        "environment": environment,
    }
    for method, retriever in (
        ("deterministic", deterministic),
        (prefix, exact),
        (f"{prefix}-hybrid", hybrid),
    ):
        result = evaluate(data, split, retriever, baseline=method)
        if method == "deterministic":
            original = json.loads((RESULTS / f"{split}.json").read_text(encoding="utf-8"))
            assert result["metrics"] == original["metrics"], "C1 metrics drifted"
            assert result["scenario_metrics"] == original["scenario_metrics"], (
                "C1 scenarios drifted"
            )
        result.update(
            {
                "retrieval_method": method,
                "model": asdict(encoder.spec) if method != "deterministic" else None,
                "serialization_version": encoder.spec.serialization_version,
                "safety_diagnostics": safety(data, queries, retriever, split),
            }
        )
        if method != "deterministic":
            result["paired_coverage_vs_c1"] = paired_coverage(
                data, queries, deterministic, retriever, split
            )
        if prefix == "gemini":
            result["executed_at_utc"] = datetime.now(UTC).isoformat()
        if isinstance(retriever, HybridRetriever):
            result["hybrid_configuration"] = {
                "semantic_top_n": 5,
                "candidate_cap": 20,
                "ordering": "C1 serious contradiction, existing score, opaque ID",
            }
        write(output / f"{method}-{split}.json", result)
        timings[method] = time_search(queries, retriever, split)
        print(
            json.dumps(
                {
                    "method": method,
                    "split": split,
                    "metrics": result["metrics"],
                    "safety": result["safety_diagnostics"],
                },
                sort_keys=True,
            )
        )
    timings["partition_total_seconds"] = time.perf_counter() - start
    timings["dataset_sha256"] = manifest["sha256"]
    if prefix == "gemini":
        timings["executed_at_utc"] = datetime.now(UTC).isoformat()
    write(output / f"{prefix}-{split}-latency.json", timings)
    return timings


def gemini_available(
    key: str | None, live: bool, factory: Callable[[], GeminiEncoder]
) -> GeminiEncoder | None:
    # The explicit flag AND a key are required; ordinary test/CI runs never call APIs.
    return factory() if live and key else None


def main() -> None:
    parser = argparse.ArgumentParser(description="Manual C2 semantic retrieval experiments")
    parser.add_argument("--provider", choices=("local", "gemini"), default="local")
    parser.add_argument("--split", choices=(*SPLITS, "development", "all"), default="development")
    parser.add_argument("--live-gemini", action="store_true")
    parser.add_argument("--offline-model", action="store_true")
    parser.add_argument(
        "--cache", type=Path, default=Path(tempfile.gettempdir()) / "contact-resolution-c2-cache"
    )
    parser.add_argument("--output", type=Path, default=RESULTS / "c2")
    args = parser.parse_args()
    start = time.perf_counter()
    data = generate()
    manifest = json.loads((RESULTS / "manifest.json").read_text(encoding="utf-8"))
    if data.manifest() != manifest:
        raise ValueError("C2 requires exactly the frozen C1 benchmark/configuration")
    encoder: LocalEncoder | GeminiEncoder
    if args.provider == "gemini":
        from app.core.config import settings

        candidate = gemini_available(
            settings.GEMINI_API_KEY,
            args.live_gemini,
            lambda: GeminiEncoder(
                settings.GEMINI_API_KEY or "", args.cache, str(manifest["sha256"])
            ),
        )
        if candidate is None:
            write(
                args.output / "gemini-status.json",
                {
                    "status": "not_executed",
                    "reason": "Requires --live-gemini and GEMINI_API_KEY",
                    "benchmark_version": manifest["version"],
                    "dataset_sha256": manifest["sha256"],
                    "model_id": GEMINI_MODEL,
                    "dimension": 768,
                    "performance_conclusion": None,
                },
            )
            print("Gemini benchmark not executed: explicit live flag and configured key required.")
            return
        encoder = candidate
    else:
        encoder = LocalEncoder(args.cache, args.offline_model)
    chosen = [
        s for s in SPLITS if args.split in (s, "all") or args.split == "development" and s != "test"
    ]
    for split in chosen:
        run_partition(data, split, encoder, args.output)
    write(
        args.output / f"{args.provider}-runtime.json",
        {
            "model": asdict(encoder.spec),
            "splits": chosen,
            "total_benchmark_seconds": time.perf_counter() - start,
            "model_loading_seconds": encoder.loading_seconds,
            "scope": "Includes model acquisition/load, embeddings, evaluation, timing and I/O",
        },
    )


if __name__ == "__main__":
    main()
