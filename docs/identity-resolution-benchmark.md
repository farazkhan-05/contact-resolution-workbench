# Identity retrieval benchmark (C1)

Run from `backend/`:

```powershell
uv run python -m benchmarks.identity_resolution --split all
```

This generates the corpus in memory, evaluates each partition independently, writes
JSON under `backend/benchmarks/identity_resolution/results/`, and prints summaries.
The default split is validation; `--seed`, `--output`, and `--latency-repeats` are
available. No database, authentication, broker, model service, or network is used.
The generator/configuration and compact results are committed; the dataset is not.
`manifest.json` records a SHA-256 fingerprint of the full logical dataset, including
ground truth. Latency files are separate so the evaluation JSON stays deterministic.

## Dataset and partitions

Version `c1-synthetic-v1`, seed `20261001`: 880 synthetic identities in 440 linked
groups, 880 queries, 1,720 candidate observations, 2,600 total records. Each group
contains two distinct people. Most identities have two provider observations and
one query; 20 identities deliberately have no candidate observation. Contacts use
`.invalid` email domains and intentionally invalid phone prefixes. No people were
scraped and no external datasets were used.

There are 20 primary queries for each of 22 designed scenarios: exact duplicates,
stale phone/email, nicknames, abbreviations, middle initials, conflicting full
middle names, Jr/Sr, II/III, employer/geography changes, marriage/name changes,
transliteration, household phones, missing fields, duplicate provider records,
namesakes, contradictory evidence, malformed fields, misleading notes, ambiguity,
and no correct candidate. Labels can overlap. The second person in each group also
has a query against its provider observations: 440 easy anchor queries are part
of the aggregate metrics. Scenario metrics expose the harder primary queries.

Groups are shuffled within scenario strata for a target 70/15/15 split. All
variants and linked negatives remain together. Identical feature profiles also
connect groups before final assignment, including completely empty queries.
The connected component takes the first group's already assigned split. This
prioritizes duplicate isolation over exact ratios; every scenario remains present
in each default partition. Unrelated people can still share names across splits.

| Split | Identities / queries | Candidates | Linked groups |
| --- | ---: | ---: | ---: |
| Train | 616 | 1,204 | 308 |
| Validation | 134 | 262 | 67 |
| Test | 130 | 254 | 65 |

Truth IDs, scenario labels, and partition assignments live in a separate label
mapping. Retrieval receives only opaque record IDs and canonical `CaseQuery`
profiles. Notes never become retrieval features. Tests check construction truth,
cross-partition identity/group/duplicate isolation for multiple seeds, and the
absence of labels from candidate features. Query IDs are removed before ordering
and from the evaluator's relevant set, including when queries share a corpus.

## Fixed retrieval baseline

`normalized-blocks-existing-score-v1` unions exact normalized email/phone blocks,
parsed first+last name blocks, and surname+employer or surname+location blocks.
Empty keys do not match. All normalization comes from the application.
The union is ordered by serious-contradiction status, then the existing five-field
total score, then opaque record ID; at most 20 records are returned. This is a
retrieval ordering, not a final resolution or probability. Contradictory records
remain available for review. Production weights, thresholds, providers, and the
Arthur Pendelton Jr/Sr demo were left unchanged.

Rules were specified from existing domain behavior and checked against train and
validation. They were frozen before test evaluation. The second test execution
only verified reproducibility; no retrieval rules were adjusted using test results.

Recall counts a query once when any observation of its true identity occurs within
K. Intentional no-match queries are excluded from recall/miss denominators and
reported separately. Candidate size statistics include all queries.

| Split | Recall@1 | Recall@5 | Recall@10 | Misses / eligible | Candidate mean / median / p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Train | 92.19% | 98.50% | 98.84% | 7 / 602 | 11.20 / 11 / 20 |
| Validation | 89.31% | 97.71% | 97.71% | 3 / 131 | 5.37 / 4 / 11 |
| Test | 92.91% | 100% | 100% | 0 / 127 | 6.17 / 6 / 13 |

All 20 no-match queries returned candidates (14 train, 3 validation, 3 test).
Retrieval does not establish that these candidates are matches. The test split's
no-match queries returned a mean of 4.67 records.

Selected held-out scenario Recall@1: suffix conflicts 100% (6 eligible queries),
namesakes 94.34% (53), marriage/name changes 100% (3), transliteration 66.67% (3),
stale phone 77.78% (9), stale email 100% (6), missing fields 100% (2), malformed
records 0% (3), ambiguous queries 33.33% (3). All reached 100% at K=5 in this run.
The scenario JSON contains exact counts and denominators.

## Timing and limits

Five passes after one untimed warmup measured normalization, index lookup, and
ordering with `perf_counter_ns`; generation, index construction, evaluation truth,
and I/O are excluded. Windows AMD64, Python 3.13.13, AMD Family 25 Model 80:

| Split | Timed calls | Median ms | Mean ms | p95 ms |
| --- | ---: | ---: | ---: | ---: |
| Train | 3,080 | 0.659 | 0.720 | 1.489 |
| Validation | 670 | 0.246 | 0.314 | 0.630 |
| Test | 650 | 0.318 | 0.356 | 0.776 |

These are local warm execution measurements, not production latency. Partition
corpora differ in size, so aggregate split comparisons do not measure improvements.
Two fresh runs had byte-identical manifests and logical results; timing varied.
Small scenario denominators and synthetic patterns limit what can be concluded
from perfect held-out Recall@5/@10. Featureless duplicate groups stay together,
so their difficulty is not evenly distributed across partitions. This establishes
an evaluation asset, not improved production accuracy. No embeddings or learned
models are implemented.
