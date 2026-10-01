"""Manual-only encoders. Imports and all network access occur on explicit invocation."""

import time
from pathlib import Path
from typing import Any, Literal

import numpy as np

from benchmarks.identity_resolution.semantic import (
    GEMINI_MODEL,
    LOCAL_MODEL,
    LOCAL_REVISION,
    EmbeddingSpec,
    Vector,
    cache_key,
    load_cache,
    normalize,
)

Role = Literal["query", "document"]


class LocalEncoder:
    spec = EmbeddingSpec(LOCAL_MODEL, LOCAL_REVISION, 384)

    def __init__(self, cache: Path, offline: bool = False) -> None:
        start = time.perf_counter()
        import torch
        from huggingface_hub import snapshot_download
        from sentence_transformers import SentenceTransformer

        torch.set_num_threads(2)
        torch.manual_seed(0)
        torch.use_deterministic_algorithms(True)
        # Explicit allowlist ensures the acquired snapshot contains no pickle weights.
        snapshot = snapshot_download(
            repo_id=LOCAL_MODEL,
            revision=LOCAL_REVISION,
            cache_dir=str(cache / "models"),
            allow_patterns=["*.json", "*.txt", "*.safetensors"],
            local_files_only=offline,
        )
        self.model = SentenceTransformer(
            snapshot,
            device="cpu",
            trust_remote_code=False,
            local_files_only=True,
            model_kwargs={"use_safetensors": True},
        )
        self.model.eval()
        if self.model.get_embedding_dimension() != self.spec.dimension:
            raise ValueError("Pinned model dimension changed")
        self.loading_seconds = time.perf_counter() - start

    def encode(self, texts: list[str], role: Role) -> tuple[Vector, dict[str, object]]:
        start = time.perf_counter()
        method = self.model.encode_query if role == "query" else self.model.encode_document
        values = method(
            texts,
            batch_size=32,
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=False,
        )
        elapsed = time.perf_counter() - start
        return normalize(values, self.spec.dimension), {
            "role": role,
            "input_count": len(texts),
            "generation_seconds": elapsed,
            "amortized_ms_per_input": elapsed * 1000 / len(texts) if texts else 0,
            "batch_size": 32,
            "api_calls": 0,
        }


class GeminiEncoder:
    # The API exposes a stable model name, not an immutable serving revision.
    spec = EmbeddingSpec(
        GEMINI_MODEL,
        "stable-api-alias-no-immutable-revision-exposed",
        768,
        task_format="gemini2-asymmetric-search-v1",
    )

    def __init__(
        self, api_key: str, cache: Path, dataset_sha: str, client: Any | None = None
    ) -> None:
        if not api_key:
            raise ValueError("Gemini API key required for explicit live evaluation")
        if client is None:
            from google import genai
            from google.genai import types

            client = genai.Client(api_key=api_key, http_options=types.HttpOptions(timeout=60000))
        self.client = client
        self.cache = cache
        self.dataset_sha = dataset_sha
        self.loading_seconds = 0.0

    def encode(self, texts: list[str], role: Role) -> tuple[Vector, dict[str, object]]:
        from google.genai import types

        prefixed = [
            f"task: search result | query: {text}"
            if role == "query"
            else f"title: none | text: {text}"
            for text in texts
        ]
        path = self.cache / (cache_key(self.spec, self.dataset_sha, role, prefixed) + ".npy")
        cached = load_cache(path, len(texts), self.spec.dimension)
        if cached is not None:
            return cached, {
                "role": role,
                "input_count": len(texts),
                "cache_hit": True,
                "api_calls": 0,
                "generation_seconds": 0.0,
                "usage": "No API response on cache hit",
            }
        vectors: list[list[float]] = []
        calls, latencies, usage = 0, [], []
        for start in range(0, len(prefixed), 64):
            batch = prefixed[start : start + 64]
            # Separate Content objects request independent vectors, not one aggregate.
            contents = [types.Content(parts=[types.Part(text=text)]) for text in batch]
            before = time.perf_counter()
            response = self.client.models.embed_content(
                model=self.spec.model_id,
                contents=contents,
                config=types.EmbedContentConfig(output_dimensionality=self.spec.dimension),
            )
            latencies.append(time.perf_counter() - before)
            calls += 1
            embeddings = response.embeddings or []
            if len(embeddings) != len(batch):
                raise ValueError("Gemini returned an aggregate or incorrect embedding count")
            for embedding in embeddings:
                if embedding.values is None:
                    raise ValueError("Gemini returned an embedding without values")
                vectors.append(embedding.values)
                stats = getattr(embedding, "statistics", None)
                if stats is not None:
                    usage.append({"statistics": stats.model_dump(exclude_none=True)})
            metadata = getattr(response, "metadata", None)
            if metadata is not None:
                usage.append({"metadata": metadata.model_dump(exclude_none=True)})
        values = normalize(np.asarray(vectors, dtype=np.float32), self.spec.dimension)
        path.parent.mkdir(parents=True, exist_ok=True)
        np.save(path, values, allow_pickle=False)
        return values, {
            "role": role,
            "input_count": len(texts),
            "cache_hit": False,
            "generation_seconds": sum(latencies),
            "api_calls": calls,
            "batch_api_seconds": latencies,
            "usage": usage or "Embedding response exposes no usage metadata",
        }
