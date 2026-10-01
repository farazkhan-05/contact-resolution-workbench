"""Exact cosine and one bounded union experiment; no production retrieval changes."""

import hashlib
import json
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
from numpy.typing import NDArray

from app.schemas.resolution import CaseQuery
from app.services.contradiction import evaluate_contradictions
from app.services.matcher import calculate_total_score, score_candidate
from app.services.normalizer import normalize_whitespace
from benchmarks.identity_resolution.dataset import VERSION, FeatureRecord, Split
from benchmarks.identity_resolution.retrieval import Retriever

SERIALIZATION = "labeled-fields-v1"
LOCAL_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
LOCAL_REVISION = "1110a243fdf4706b3f48f1d95db1a4f5529b4d41"
GEMINI_MODEL = "gemini-embedding-2"
Vector = NDArray[np.float32]


def serialize(profile: CaseQuery) -> str:
    # Only legitimate product fields. No record IDs, notes, or evaluator metadata.
    fields = (
        "name",
        "first_name",
        "middle_name",
        "last_name",
        "name_suffix",
        "email",
        "phone",
        "employer",
        "location",
    )
    parts = []
    for field in fields:
        value = getattr(profile, field)
        if value and (cleaned := normalize_whitespace(value)):
            parts.append(f"{field}: {cleaned}")
    return " | ".join(parts) or "identity record: no available fields"


@dataclass(frozen=True)
class EmbeddingSpec:
    model_id: str
    revision: str
    dimension: int
    serialization_version: str = SERIALIZATION
    task_format: str = "encode-query-document-v1"


def cache_key(spec: EmbeddingSpec, dataset_sha: str, role: str, texts: list[str]) -> str:
    payload = {
        "benchmark_version": VERSION,
        "dataset_sha256": dataset_sha,
        "embedding": asdict(spec),
        "role": role,
        "texts": texts,
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def normalize(vectors: Vector, dimension: int) -> Vector:
    vectors = np.asarray(vectors, dtype=np.float32)
    if vectors.ndim != 2 or vectors.shape[1] != dimension or not np.isfinite(vectors).all():
        raise ValueError("Embedding shape/dimension or finite-value validation failed")
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    if np.any(norms == 0):
        raise ValueError("Zero embedding is not a cosine direction")
    return np.asarray(vectors / norms, dtype=np.float32)


def load_cache(path: Path, count: int, dimension: int) -> Vector | None:
    if not path.exists():
        return None
    # No pickle deserialization, including for local caches.
    values = np.asarray(np.load(path, allow_pickle=False), dtype=np.float32)
    normalize(values, dimension)  # Validate without renormalizing already normalized cached values.
    if not np.allclose(np.linalg.norm(values, axis=1), 1.0, rtol=1e-5, atol=1e-6):
        raise ValueError("Cached embeddings must already be normalized")
    if len(values) != count:
        raise ValueError("Cached embedding count differs from inputs")
    return values


class ExactRetriever:
    def __init__(
        self,
        corpus: Retriever,
        ids: list[str],
        vectors: Vector,
        queries: dict[str, Vector],
        limit: int = 20,
    ) -> None:
        if limit < 10 or set(ids) != set(corpus.records) or len(ids) != len(set(ids)):
            raise ValueError("Invalid limit or embedding corpus configuration")
        self.records = corpus.records
        self.split = corpus.split
        self.limit = limit
        self.ids = ids
        self.vectors = normalize(vectors, vectors.shape[1])
        if len(ids) != len(self.vectors):
            raise ValueError("Embedding count differs from corpus")
        self.queries = queries

    def search(self, query: FeatureRecord, split: Split) -> list[str]:
        if split != self.split:
            raise ValueError("Query partition does not match configured corpus")
        vector = normalize(self.queries[query.record_id].reshape(1, -1), self.vectors.shape[1])[0]
        scores = self.vectors @ vector
        ordered = sorted(range(len(self.ids)), key=lambda i: (-float(scores[i]), self.ids[i]))
        return [self.ids[i] for i in ordered if self.ids[i] != query.record_id][: self.limit]


class HybridRetriever:
    """C1 top-20 union semantic top-5, C1 ordering, then top-20. Fixed before test."""

    def __init__(
        self,
        deterministic: Retriever,
        semantic: ExactRetriever,
        semantic_top_n: int = 5,
        limit: int = 20,
    ) -> None:
        if deterministic.split != semantic.split or set(deterministic.records) != set(
            semantic.records
        ):
            raise ValueError("Hybrid sources must have identical partitions and corpora")
        if not 1 <= semantic_top_n <= semantic.limit or limit < 10:
            raise ValueError("Invalid hybrid candidate limits")
        self.deterministic = deterministic
        self.semantic = semantic
        self.records = deterministic.records
        self.limit = limit
        self.semantic_top_n = semantic_top_n

    def search(self, query: FeatureRecord, split: Split) -> list[str]:
        pool = set(self.deterministic.search(query, split))
        pool.update(self.semantic.search(query, split)[: self.semantic_top_n])
        pool.discard(query.record_id)

        def order(record_id: str) -> tuple[bool, int, str]:
            candidate = self.records[record_id]
            blocked = any(
                c.blocks_likely_match for c in evaluate_contradictions(query.profile, candidate)
            )
            return (
                blocked,
                -calculate_total_score(score_candidate(query.profile, candidate)),
                record_id,
            )

        return sorted(pool, key=order)[: self.limit]
