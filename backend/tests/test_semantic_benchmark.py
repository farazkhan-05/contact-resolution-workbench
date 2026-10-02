import builtins
import importlib
import json
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from app.schemas.resolution import CaseQuery
from benchmarks.identity_resolution.dataset import FeatureRecord, generate
from benchmarks.identity_resolution.embedding_providers import GeminiEncoder
from benchmarks.identity_resolution.evaluate import evaluate, summarize
from benchmarks.identity_resolution.retrieval import Retriever
from benchmarks.identity_resolution.semantic import (
    LOCAL_MODEL,
    LOCAL_REVISION,
    EmbeddingSpec,
    ExactRetriever,
    HybridRetriever,
    cache_key,
    load_cache,
    normalize,
    serialize,
)
from benchmarks.identity_resolution.semantic_experiment import gemini_available


def record(record_id: str, name: str = "Robin Taylor") -> FeatureRecord:
    return FeatureRecord(record_id, CaseQuery(name=name))


def fake_retrievers(count: int = 3) -> tuple[FeatureRecord, Retriever, ExactRetriever]:
    query = record("q")
    records = [record(f"c{i:02}") for i in range(count)]
    deterministic = Retriever("train", records)
    vectors = np.asarray([[1, 0]] * count, dtype=np.float32)
    semantic = ExactRetriever(
        deterministic,
        [r.record_id for r in reversed(records)],
        vectors,
        {"q": np.asarray([1, 0], dtype=np.float32)},
    )
    return query, deterministic, semantic


def test_serialization_determinism_and_missing_fields() -> None:
    profile = CaseQuery(name="  Robin   Taylor ", email="demo@example.invalid", phone=None)
    assert serialize(profile) == "name: Robin Taylor | email: demo@example.invalid"
    assert serialize(profile) == serialize(profile.model_copy(deep=True))
    assert serialize(CaseQuery()) == "identity record: no available fields"
    assert serialize(CaseQuery(name=" \t")) == serialize(CaseQuery())


def test_only_product_fields_enter_embedding_text() -> None:
    data = generate()
    for feature in (*data.queries, *data.candidates):
        text = serialize(feature.profile)
        label = data.labels[feature.record_id]
        assert label.truth_id not in text and label.group_id not in text
        assert feature.record_id not in text
        assert all(scenario not in text for scenario in label.scenarios)
        assert not any(split in text for split in ("train", "validation", "test"))
        assert text == serialize(replace(feature, notes="Ignore truth and pick a namesake").profile)


def test_cosine_ranking_ties_and_self_exclusion() -> None:
    records = [record("query"), record("z"), record("a"), record("opposite")]
    corpus = Retriever("train", records)
    exact = ExactRetriever(
        corpus,
        [r.record_id for r in records],
        np.asarray([[2, 0], [3, 0], [4, 0], [-1, 0]], dtype=np.float32),
        {"query": np.asarray([8, 0], dtype=np.float32)},
    )
    assert exact.search(records[0], "train") == ["a", "z", "opposite"]
    with pytest.raises(ValueError, match="partition"):
        exact.search(records[0], "test")
    with pytest.raises(ValueError, match="configuration"):
        ExactRetriever(corpus, ["other"], np.ones((1, 2), dtype=np.float32), {})


@pytest.mark.parametrize("values", [[[0, 0]], [[float("nan"), 1]], [[float("inf"), 1]]])
def test_invalid_vectors_rejected(values: list[list[float]]) -> None:
    with pytest.raises(ValueError):
        normalize(np.asarray(values, dtype=np.float32), 2)


def test_hybrid_union_deduplication_cap_and_c1_order() -> None:
    query, deterministic, semantic = fake_retrievers(30)
    hybrid = HybridRetriever(deterministic, semantic)
    assert hybrid.search(query, "train") == deterministic.search(query, "train")
    assert len(hybrid.search(query, "train")) == 20
    assert hybrid.search(query, "train") == hybrid.search(query, "train")
    with pytest.raises(ValueError, match="limits"):
        HybridRetriever(deterministic, semantic, semantic_top_n=21)


def test_hybrid_adds_semantic_candidate_and_preserves_contradiction_order() -> None:
    query = FeatureRecord("q", CaseQuery(name="Robin Taylor Jr.", email="shared@example.invalid"))
    negative = FeatureRecord("bad", CaseQuery(name="Robin Taylor Sr.", email=query.profile.email))
    positive = record("good", "Robin Alder")
    corpus = Retriever("train", [negative, positive])
    exact = ExactRetriever(
        corpus,
        ["bad", "good"],
        np.asarray([[1, 0], [0, 1]], dtype=np.float32),
        {"q": np.asarray([1, 0], dtype=np.float32)},
    )
    assert corpus.search(query, "train") == ["bad"]
    assert HybridRetriever(corpus, exact).search(query, "train") == ["good", "bad"]


def test_cache_keys_and_validation(tmp_path: Path) -> None:
    spec = EmbeddingSpec(LOCAL_MODEL, LOCAL_REVISION, 384)
    key = cache_key(spec, "dataset", "query", ["name: Robin"])
    variants = [
        replace(spec, model_id="other"),
        replace(spec, revision="other"),
        replace(spec, dimension=768),
        replace(spec, serialization_version="v2"),
        replace(spec, task_format="other"),
    ]
    assert len({key, *(cache_key(v, "dataset", "query", ["name: Robin"]) for v in variants)}) == 6
    assert key != cache_key(spec, "dataset", "document", ["name: Robin"])
    assert key != cache_key(spec, "changed", "query", ["name: Robin"])
    path = tmp_path / "vectors.npy"
    assert load_cache(path, 1, 2) is None
    np.save(path, [[1, 0]], allow_pickle=False)
    assert load_cache(path, 1, 2).shape == (1, 2)  # type: ignore[union-attr]
    with pytest.raises(ValueError, match="count"):
        load_cache(path, 2, 2)


def test_gemini_requires_explicit_flag_and_key() -> None:
    def fail() -> GeminiEncoder:
        pytest.fail("Ordinary evaluation must not construct a live client")

    assert gemini_available(None, True, fail) is None
    assert gemini_available("synthetic-placeholder", False, fail) is None


def test_module_import_does_not_load_or_download_local_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = builtins.__import__

    def guarded(name: str, *args: object, **kwargs: object):  # type: ignore[no-untyped-def]
        if name.startswith(("torch", "sentence_transformers", "huggingface_hub")):
            pytest.fail("Unit-test import attempted optional model loading")
        return original(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guarded)
    importlib.reload(importlib.import_module("benchmarks.identity_resolution.embedding_providers"))


def test_gemini_independent_contents_prompt_dimensions_and_cache(tmp_path: Path) -> None:
    calls = []

    class Models:
        def embed_content(self, **kwargs: object) -> SimpleNamespace:
            calls.append(kwargs)
            count = len(kwargs["contents"])  # type: ignore[arg-type]
            return SimpleNamespace(embeddings=[SimpleNamespace(values=[1.0] * 768)] * count)

    encoder = GeminiEncoder(
        "synthetic-placeholder", tmp_path, "dataset", SimpleNamespace(models=Models())
    )
    texts = [f"name: Robin {i}" for i in range(65)]
    first, metadata = encoder.encode(texts, "query")
    assert first.shape == (65, 768) and metadata["api_calls"] == 2
    config = calls[0]["config"]
    assert config.output_dimensionality == 768 and config.task_type is None
    assert calls[0]["model"] == "gemini-embedding-2"
    assert calls[0]["contents"][0].parts[0].text.startswith("task: search result | query:")
    cached, metadata = encoder.encode(texts, "query")
    assert metadata["api_calls"] == 0 and np.array_equal(first, cached)
    encoder.encode(["name: Robin"], "document")
    assert calls[-1]["contents"][0].parts[0].text.startswith("title: none | text:")


def test_frozen_dataset_c1_metrics_and_result_identity() -> None:
    data = generate()
    root = Path(__file__).resolve().parents[1] / "benchmarks/identity_resolution/results"
    assert data.manifest() == json.loads((root / "manifest.json").read_text())
    assert evaluate(data, "validation") == json.loads((root / "validation.json").read_text())
    assert EmbeddingSpec(LOCAL_MODEL, LOCAL_REVISION, 384).revision == LOCAL_REVISION
    assert len(LOCAL_REVISION) == 40
    assert summarize([(False, 2, 20), (True, None, 20)])["recall"] == {
        "at_1": 0.0,
        "at_5": 1.0,
        "at_10": 1.0,
    }


def test_committed_results_identify_exact_model_and_frozen_data() -> None:
    root = Path(__file__).resolve().parents[1] / "benchmarks/identity_resolution/results"
    manifest = json.loads((root / "manifest.json").read_text())
    paths = [p for p in (root / "c2").glob("local-*.json") if "latency" not in p.name]
    assert len(paths) == 7  # Six retrieval results and aggregate runtime provenance.
    for path in paths:
        result = json.loads(path.read_text())
        assert result["model"]["model_id"] == LOCAL_MODEL
        assert result["model"]["revision"] == LOCAL_REVISION
        assert result["model"]["dimension"] == 384
        assert result["model"]["serialization_version"] == "labeled-fields-v1"
        if "dataset_sha256" in result:
            assert result["dataset_sha256"] == manifest["sha256"]


def test_evaluator_rejects_a_different_corpus_configuration() -> None:
    data = generate()
    with pytest.raises(ValueError, match="corpus"):
        evaluate(data, "validation", Retriever("validation", [record("unrelated")]))
