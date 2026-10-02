"""Evaluation labels never enter the retriever; timings are a separate artifact."""

import platform
import statistics
import time
from collections.abc import Sequence
from typing import Protocol

from app.schemas.resolution import RawCandidate
from benchmarks.identity_resolution.dataset import VERSION, Dataset, FeatureRecord, Split
from benchmarks.identity_resolution.retrieval import BASELINE, Retriever


class Searcher(Protocol):
    records: dict[str, RawCandidate]
    limit: int

    def search(self, query: FeatureRecord, split: Split) -> list[str]: ...


def percentile95(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    return sorted(values)[max(0, (95 * len(values) + 99) // 100 - 1)]


def summarize(outcomes: Sequence[tuple[bool, int | None, int]]) -> dict[str, object]:
    """Recall is identity-level: any correct provider observation satisfies K.

    No-match queries are excluded from recall and miss denominators, but included
    in candidate size statistics. They are reported separately, without pretending
    retrieval alone is a no-match classifier.
    """
    eligible = [rank for no_match, rank, _ in outcomes if not no_match]
    sizes = [size for _, _, size in outcomes]
    misses = sum(rank is None for rank in eligible)
    no_match_sizes = [size for no_match, _, size in outcomes if no_match]
    return {
        "query_count": len(outcomes),
        "eligible_query_count": len(eligible),
        "recall": {
            f"at_{k}": sum(rank is not None and rank <= k for rank in eligible) / len(eligible)
            if eligible
            else None
            for k in (1, 5, 10)
        },
        "miss_count": misses,
        "miss_rate": misses / len(eligible) if eligible else None,
        "candidate_set_size": {
            "mean": statistics.mean(sizes) if sizes else 0,
            "median": statistics.median(sizes) if sizes else 0,
            "p95": percentile95(sizes),
        },
        "no_correct_candidate": {
            "query_count": len(no_match_sizes),
            "with_candidates": sum(size > 0 for size in no_match_sizes),
            "mean_candidate_set_size": statistics.mean(no_match_sizes) if no_match_sizes else 0,
        },
    }


def partition(data: Dataset, split: Split) -> tuple[tuple[FeatureRecord, ...], Retriever]:
    corpus = tuple(c for c in data.candidates if data.labels[c.record_id].split == split)
    queries = tuple(q for q in data.queries if data.labels[q.record_id].split == split)
    return queries, Retriever(split, corpus)


def evaluate(
    data: Dataset, split: Split, retriever: Searcher | None = None, baseline: str = BASELINE
) -> dict[str, object]:
    queries, default_retriever = partition(data, split)
    configured = retriever if retriever is not None else default_retriever
    if set(configured.records) != set(default_retriever.records):
        raise ValueError("Retriever corpus differs from the configured benchmark partition")
    outcomes: list[tuple[bool, int | None, int]] = []
    scenarios: dict[str, list[tuple[bool, int | None, int]]] = {}
    for query in queries:
        label = data.labels[query.record_id]
        ids = configured.search(query, split)
        relevant = {
            c.record_id
            for c in data.candidates
            if c.record_id != query.record_id
            and data.labels[c.record_id].split == split
            and data.labels[c.record_id].truth_id == label.truth_id
        }
        if label.no_correct_candidate != (not relevant):
            raise ValueError("Construction truth and configured corpus disagree")
        rank = next((i for i, record_id in enumerate(ids, 1) if record_id in relevant), None)
        outcome = label.no_correct_candidate, rank, len(ids)
        outcomes.append(outcome)
        for scenario in label.scenarios:
            scenarios.setdefault(scenario, []).append(outcome)
    return {
        "benchmark_version": VERSION,
        "configuration": data.manifest()["configuration"],
        "dataset_sha256": data.manifest()["sha256"],
        "split": split,
        "baseline": baseline,
        "candidate_limit": configured.limit,
        "corpus_size": len(configured.records),
        "metrics": summarize(outcomes),
        "scenario_metrics": {s: summarize(v) for s, v in sorted(scenarios.items())},
    }


def measure_latency(data: Dataset, split: Split, repeats: int = 5) -> dict[str, object]:
    if repeats < 1:
        raise ValueError("repeats must be positive")
    queries, retriever = partition(data, split)
    for query in queries:
        retriever.search(query, split)  # One untimed warmup; excludes index construction.
    times = []
    for _ in range(repeats):
        for query in queries:
            start = time.perf_counter_ns()
            retriever.search(query, split)
            times.append((time.perf_counter_ns() - start) / 1_000_000)
    return {
        "split": split,
        "repeats": repeats,
        "timed_calls": len(times),
        "median_ms": statistics.median(times) if times else 0,
        "mean_ms": statistics.mean(times) if times else 0,
        "p95_ms": percentile95(times),
        "python": platform.python_version(),
        "system": platform.system(),
        "machine": platform.machine(),
        "processor": platform.processor(),
        "corpus_size": len(retriever.records),
        "scope": "Local warm retrieval calls, including normalization, blocking and ordering; "
        "excluding generation, index construction, truth evaluation and I/O",
    }
