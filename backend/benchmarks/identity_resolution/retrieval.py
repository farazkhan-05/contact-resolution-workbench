"""Fixed non-learned baseline. No truth, scenario labels, or notes are features."""

from collections import defaultdict
from collections.abc import Iterable

from app.schemas.resolution import CaseQuery, RawCandidate
from app.services.contradiction import evaluate_contradictions
from app.services.matcher import calculate_total_score, score_candidate
from app.services.normalizer import (
    normalize_email,
    normalize_employer,
    normalize_location,
    normalize_name,
    normalize_phone,
    parse_name_parts,
)
from benchmarks.identity_resolution.dataset import FeatureRecord, Split

BASELINE = "normalized-blocks-existing-score-v1"


def blocking_keys(profile: CaseQuery) -> set[tuple[str, ...]]:
    """Union of contact and compound name/context blocks; empty keys never match."""
    keys: set[tuple[str, ...]] = set()
    for kind, value in (
        ("email", normalize_email(profile.email)),
        ("phone", normalize_phone(profile.phone)),
    ):
        if value:
            keys.add((kind, value))
    parts = parse_name_parts(profile.name)
    first = normalize_name(parts["first_name"])
    last = normalize_name(parts["last_name"])
    if first and last:
        keys.add(("name", first, last))
    if last:
        for kind, value in (
            ("employer", normalize_employer(profile.employer)),
            ("location", normalize_location(profile.location)),
        ):
            if value:
                keys.add(("surname", last, kind, value))
    return keys


class Retriever:
    def __init__(self, split: Split, records: Iterable[FeatureRecord], limit: int = 20) -> None:
        if limit < 10:
            raise ValueError("limit must be at least 10 for Recall@10")
        self.split = split
        self.limit = limit
        self.records: dict[str, RawCandidate] = {}
        self.index: dict[tuple[str, ...], set[str]] = defaultdict(set)
        for record in records:
            if record.record_id in self.records:
                raise ValueError("Duplicate corpus record ID")
            self.records[record.record_id] = RawCandidate(
                **(record.profile.model_dump(exclude={"name"})),
                name=record.profile.name or "",
                provider_source="BENCHMARK",
                provider_record_id=record.record_id,
                provenance_summary="Synthetic corpus",
            )
            for key in blocking_keys(record.profile):
                self.index[key].add(record.record_id)

    def search(self, query: FeatureRecord, split: Split) -> list[str]:
        if split != self.split:
            raise ValueError("Query partition does not match configured corpus")
        pool: set[str] = set()
        for key in blocking_keys(query.profile):
            pool.update(self.index.get(key, ()))
        pool.discard(query.record_id)

        def order(record_id: str) -> tuple[bool, int, str]:
            candidate = self.records[record_id]
            blocked = any(
                c.blocks_likely_match for c in evaluate_contradictions(query.profile, candidate)
            )
            score = calculate_total_score(score_candidate(query.profile, candidate))
            return blocked, -score, record_id

        return sorted(pool, key=order)[: self.limit]
