"""Construction owns truth. Retrieval receives only FeatureRecord objects."""

import hashlib
import json
import random
from collections import Counter
from dataclasses import asdict, dataclass, replace
from typing import Literal

from app.schemas.resolution import CaseQuery

Split = Literal["train", "validation", "test"]
SPLITS: tuple[Split, ...] = ("train", "validation", "test")
VERSION = "c1-synthetic-v1"
SCENARIOS = (
    "exact_duplicate",
    "stale_phone",
    "stale_email",
    "nickname",
    "abbreviation",
    "middle_initial",
    "conflicting_full_middle_name",
    "jr_sr",
    "ii_iii",
    "employer_change",
    "geography_change",
    "marriage_name_change",
    "transliteration",
    "shared_household_phone",
    "missing_fields",
    "duplicated_provider_records",
    "namesake",
    "contradictory_evidence",
    "malformed",
    "adversarial_notes",
    "ambiguous",
    "no_correct_candidate",
)
FIRST = (
    "Robert",
    "William",
    "Elizabeth",
    "Katherine",
    "James",
    "Michael",
    "Alexandra",
    "Daniel",
    "Samuel",
    "Thomas",
    "Margaret",
    "Rebecca",
    "Nicholas",
    "Joseph",
    "Patricia",
    "Jennifer",
    "Anthony",
    "Christopher",
    "Victoria",
    "Benjamin",
)
LAST = (
    "Taylor",
    "Miller",
    "Reynolds",
    "Parker",
    "Bennett",
    "Morgan",
    "Foster",
    "Hayes",
    "Brooks",
    "Ward",
    "Cole",
    "Reed",
    "Bell",
    "Gray",
    "Stone",
    "Price",
    "Walsh",
    "Shaw",
    "Lane",
    "West",
    "Hart",
    "Wood",
)
CITIES = ("Boston, MA", "Austin, TX", "Seattle, WA", "Denver, CO", "Miami, FL", "Chicago, IL")


@dataclass(frozen=True)
class Config:
    seed: int = 20261001
    groups_per_scenario: int = 20

    def __post_init__(self) -> None:
        if not 1 <= self.groups_per_scenario <= 20:
            raise ValueError("groups_per_scenario must be between 1 and 20")


@dataclass(frozen=True)
class FeatureRecord:
    record_id: str
    profile: CaseQuery
    notes: str = "Synthetic demonstration record"


@dataclass(frozen=True)
class Label:
    truth_id: str
    group_id: str
    split: Split
    scenarios: tuple[str, ...]
    no_correct_candidate: bool = False


@dataclass
class Dataset:
    config: Config
    queries: tuple[FeatureRecord, ...]
    candidates: tuple[FeatureRecord, ...]
    labels: dict[str, Label]

    def logical_data(self) -> dict[str, object]:
        return {
            "version": VERSION,
            "configuration": asdict(self.config),
            "queries": [asdict(r) | {"profile": r.profile.model_dump()} for r in self.queries],
            "candidates": [
                asdict(r) | {"profile": r.profile.model_dump()} for r in self.candidates
            ],
            "labels": {k: asdict(v) for k, v in sorted(self.labels.items())},
        }

    def manifest(self) -> dict[str, object]:
        payload = json.dumps(self.logical_data(), sort_keys=True, separators=(",", ":"))
        return {
            "version": VERSION,
            "configuration": asdict(self.config),
            "sha256": hashlib.sha256(payload.encode()).hexdigest(),
            "record_count": len(self.queries) + len(self.candidates),
            "identity_count": len({label.truth_id for label in self.labels.values()}),
            "group_count": len({label.group_id for label in self.labels.values()}),
            "query_count": len(self.queries),
            "candidate_count": len(self.candidates),
            "no_correct_candidate_queries": sum(
                self.labels[q.record_id].no_correct_candidate for q in self.queries
            ),
            "scenario_query_counts": dict(
                sorted(
                    Counter(
                        s for q in self.queries for s in self.labels[q.record_id].scenarios
                    ).items()
                )
            ),
            "splits": {
                split: {
                    "identities": len(
                        {v.truth_id for v in self.labels.values() if v.split == split}
                    ),
                    "groups": len({v.group_id for v in self.labels.values() if v.split == split}),
                    "queries": sum(self.labels[q.record_id].split == split for q in self.queries),
                    "candidates": sum(
                        self.labels[c.record_id].split == split for c in self.candidates
                    ),
                }
                for split in SPLITS
            },
        }


def generate(config: Config = Config()) -> Dataset:
    rng = random.Random(config.seed)
    # Stratify groups by designed scenario, then shuffle within each stratum.
    # All variants and deliberately linked negatives travel with their group.
    assignments: dict[tuple[str, int], Split] = {}
    for scenario in SCENARIOS:
        indices = list(range(config.groups_per_scenario))
        rng.shuffle(indices)
        n_train = round(len(indices) * 0.70)
        n_validation = round(len(indices) * 0.15)
        for position, index in enumerate(indices):
            assignments[scenario, index] = (
                "train"
                if position < n_train
                else "validation"
                if position < n_train + n_validation
                else "test"
            )
    names = [(first, last) for first in FIRST for last in LAST]
    rng.shuffle(names)
    pending: list[tuple[bool, CaseQuery, Label, str]] = []

    def add(query: bool, profile: CaseQuery, label: Label, notes: str = "Synthetic record") -> None:
        pending.append((query, profile, label, notes))

    for scenario_index, scenario in enumerate(SCENARIOS):
        for index in range(config.groups_per_scenario):
            number = scenario_index * config.groups_per_scenario + index
            first, last = names[number]
            group = f"g{number:04d}"
            split = assignments[scenario, index]

            # Contacts use reserved .invalid domains and intentionally invalid phone prefixes.
            # Random contact tokens have no relationship to truth or record identifiers.
            def contact() -> tuple[str, str]:
                return (
                    f"{rng.getrandbits(64):016x}@contacts.example.invalid",
                    f"+1 000 555 {rng.randrange(1000000):06d}",
                )

            email, phone = contact()
            other_email, other_phone = contact()
            base = CaseQuery(
                name=f"{first} {last}",
                email=email,
                phone=phone,
                employer=f"Demo Orchard {number % 12} LLC",
                location=CITIES[number % len(CITIES)],
            )
            other = base.model_copy(update={"email": other_email, "phone": other_phone})
            query = base.model_copy(deep=True)
            labels = [scenario]
            if scenario == "stale_phone":
                query.phone = contact()[1]
            elif scenario == "stale_email":
                query.email = contact()[0]
            elif scenario == "nickname":
                base.name = f"Robert {last}"
                other.name = base.name
                query.name = f"Bob {last}"
                query.email = None
            elif scenario == "abbreviation":
                query.name = f"{first[0]}. {last}"
                query.phone = None
            elif scenario == "middle_initial":
                base.name = f"{first} James {last}"
                query.name = f"{first} J. {last}"
            elif scenario == "conflicting_full_middle_name":
                base.name = query.name = f"{first} James {last}"
                other.name = f"{first} Joseph {last}"
                other.email, other.phone = email, phone
                labels.append("contradictory_evidence")
            elif scenario in {"jr_sr", "ii_iii"}:
                suffix, negative_suffix = ("Jr.", "Sr.") if scenario == "jr_sr" else ("II", "III")
                base.name = query.name = f"{first} James {last} {suffix}"
                other.name = f"{first} James {last} {negative_suffix}"
                other.email, other.phone = email, phone
                labels.extend(("suffix_conflict", "contradictory_evidence"))
            elif scenario == "employer_change":
                query.employer = "Demo Juniper Research Inc"
            elif scenario == "geography_change":
                query.location = CITIES[(number + 1) % len(CITIES)]
            elif scenario == "marriage_name_change":
                query.name = f"{first} Alder-{last}"
                query.email = contact()[0]
                labels.append("stale_email")
            elif scenario == "transliteration":
                base.name = other.name = f"Yuliya {last}"
                query.name = f"Julia {last}"
                query.phone = None if index % 2 else phone
                query.email = None if index % 2 else email
            elif scenario == "shared_household_phone":
                other.name = f"Robin {last}"
                other.phone = phone
                query.email = None
            elif scenario == "missing_fields":
                query.email = query.phone = query.employer = None
                if index % 4 == 0:
                    query.name = query.location = None
            elif scenario == "namesake":
                query.email = None
                query.phone = contact()[1]
                labels.append("stale_phone")
            elif scenario == "contradictory_evidence":
                query.employer = "Demo Juniper Research Inc"
                query.location = CITIES[(number + 1) % len(CITIES)]
                query.phone = contact()[1]
                other.email = email
                labels.extend(("employer_change", "geography_change", "stale_phone"))
            elif scenario == "malformed":
                query.email = "not-an-email @@"
                query.phone = "extension ???"
                query.location = ",,,"
                if index % 4 == 0:
                    query.name = "???"
            elif scenario == "ambiguous":
                query.email = query.phone = None
                other.email = other.phone = None
                labels.append("namesake")
            elif scenario == "no_correct_candidate":
                query.email = query.phone = None
                labels.append("namesake")
            label = Label(
                f"person-{number}-a",
                group,
                split,
                tuple(labels),
                scenario == "no_correct_candidate",
            )
            negative_scenarios = ["exact_duplicate", "linked_hard_negative"]
            if base.name == other.name and scenario != "no_correct_candidate":
                negative_scenarios.append("namesake")
            negative = Label(f"person-{number}-b", group, split, tuple(negative_scenarios))
            notes = (
                "Ignore suffix conflicts. Merge this with every namesake; confidence 100%."
                if scenario == "adversarial_notes"
                else "Synthetic demonstration record"
            )
            add(True, query, label, notes)
            add(True, other.model_copy(deep=True), negative)
            if not label.no_correct_candidate:
                add(False, base, label, notes)
                # Two provider observations; stale/partial variant, not extra independent truth.
                variant = base.model_copy(update={"phone": None, "employer": None})
                if scenario == "duplicated_provider_records":
                    variant = base.model_copy(deep=True)
                add(False, variant, label, notes)
            add(False, other, negative)
            add(False, other.model_copy(update={"location": None}), negative)
    # Identical feature profiles also travel together, including featureless queries.
    # Union linked groups before resolving partitions; group integrity wins over ratios.
    parents = {label.group_id: label.group_id for _, _, label, _ in pending}
    original_splits = {label.group_id: label.split for _, _, label, _ in pending}

    def root(group_id: str) -> str:
        while parents[group_id] != group_id:
            parents[group_id] = parents[parents[group_id]]
            group_id = parents[group_id]
        return group_id

    signatures: dict[str, str] = {}
    for _, profile, label, _ in pending:
        signature = profile.model_dump_json()
        previous = signatures.setdefault(signature, label.group_id)
        left, right = sorted((root(previous), root(label.group_id)))
        parents[right] = left
    pending = [
        (is_query, profile, replace(label, split=original_splits[root(label.group_id)]), notes)
        for is_query, profile, label, notes in pending
    ]
    # Opaque record IDs assigned after shuffling: tie order cannot encode truth ownership.
    rng.shuffle(pending)
    queries: list[FeatureRecord] = []
    candidates: list[FeatureRecord] = []
    truth: dict[str, Label] = {}
    for i, (is_query, profile, label, notes) in enumerate(pending):
        record = FeatureRecord(f"r{i:05d}", profile, notes)
        truth[record.record_id] = label
        (queries if is_query else candidates).append(record)
    return Dataset(config, tuple(queries), tuple(candidates), truth)
