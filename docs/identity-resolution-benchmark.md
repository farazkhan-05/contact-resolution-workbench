# Identity retrieval benchmark (C1 and C2)

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
an evaluation asset, not improved production accuracy. C1 implements no embeddings
or learned models.

## C2 semantic experiment

C2 keeps the C1 generator, configuration, corpus, partitions, truth, and metric
definitions unchanged. The runner checks the complete manifest and recomputes C1
metrics against the committed artifacts. Only the evaluator's retriever interface
was extended. Representation and the single hybrid configuration were fixed before
held-out evaluation; no model was trained and no test results were used to tune them.

Manual local commands, from `backend/`:

```powershell
uv sync --frozen --group semantic-benchmark
uv run --group semantic-benchmark python -m benchmarks.identity_resolution.semantic_experiment
uv run --group semantic-benchmark python -m benchmarks.identity_resolution.semantic_experiment --split all --offline-model
```

The first command installs the optional model packages. The first model execution
downloads the canonical publisher's snapshot; the default run evaluates only train
and validation. `--offline-model` requires those cached weights and prevents another
download. Normal pytest uses fake vectors and does not import/download the model.
Normal CI installs NumPy for the vector tests, but not the optional transformer group.

[Official PyPI](https://pypi.org/project/sentence-transformers/) verified stable
Sentence Transformers 6.1.0 and Python 3.13 compatibility. The selected model is
[`sentence-transformers/all-MiniLM-L6-v2`](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2),
pinned to revision `1110a243fdf4706b3f48f1d95db1a4f5529b4d41`, with 384 dimensions.
Only JSON, text/tokenizer files, and safetensors are acquired from that repository.
Loading uses CPU, `trust_remote_code=False`, local files, and `use_safetensors=True`.
Model weights live in a temporary cache outside the repository and are not committed.
Windows/Linux PyTorch is resolved through its [official CPU wheel index](https://download.pytorch.org/whl/cpu);
the lock contains no CUDA packages. All previous package versions stayed unchanged.
NumPy 2.5.3 is a dev dependency; transformer packages and PyTorch 2.14.1+cpu are
optional. Scikit-learn is a Sentence Transformers transitive dependency, unused
by the experiment for fitting or ranking. No pretrained models were fine-tuned.

Serialization `labeled-fields-v1` uses a fixed order: name, available parsed name
fields/suffix, email, phone, employer, location. Whitespace is normalized, empty
fields are omitted, and a featureless record has a constant placeholder. Both
queries and documents contain only product fields; notes, record IDs, truth,
scenario, and partition labels are absent. The local encoder uses `encode_query`
and `encode_document`, batch size 32, normalized float32 vectors, and exact cosine
search. Similarity ties use opaque record ID. Self-matches are removed before K.

Pure semantic retrieval returns the top 20 records without a probability or a
similarity cutoff. The one hybrid unions C1's bounded set with semantic top 5,
deduplicates, applies C1's serious-contradiction/score/ID ordering, and caps at 20.
Embedding similarity cannot override that ordering or production contradiction gates.

| Split / method | Recall@1 | Recall@5 | Recall@10 | Misses from top 20 |
| --- | ---: | ---: | ---: | ---: |
| Train / C1 | 92.19% | 98.50% | 98.84% | 7 / 602 |
| Train / MiniLM | 80.90% | 95.18% | 96.01% | 16 / 602 |
| Train / hybrid | 92.19% | 98.50% | 98.84% | 7 / 602 |
| Validation / C1 | 89.31% | 97.71% | 97.71% | 3 / 131 |
| Validation / MiniLM | 82.44% | 96.18% | 96.95% | 4 / 131 |
| Validation / hybrid | 89.31% | 97.71% | 97.71% | 3 / 131 |
| Test / C1 | 92.91% | 100% | 100% | 0 / 127 |
| Test / MiniLM | 81.10% | 98.43% | 100% | 0 / 127 |
| Test / hybrid | 92.91% | 100% | 100% | 0 / 127 |

Semantic retrieval recovered none of C1's misses at K=5, 10, or 20 on any split.
It did improve individual top-1 rankings: 17 train, 3 validation, and 2 test queries;
it simultaneously lost 85, 12, and 17 formerly correct top-1 rankings. The hybrid
changed no query's correct-identity coverage at any measured K on any split.

On test, MiniLM lowered top-1 recall for marriage/name change (100% to 33.33%),
nickname (100% to 0%), transliteration (66.67% to 0%), geography change (66.67%
to 33.33%), stale phone (77.78% to 66.67%), stale email (100% to 66.67%), and
namesakes (94.34% to 92.45%). Employer change remained 66.67%, but one top-1 win
and one loss canceled. Suffix conflicts, shared household phones, and missing
fields retained their top-1 results. These scenario samples are small and overlap.
Train transliteration Recall@10 fell from 100% to 0%; validation fell to 66.67%.
Some validation namesake/stale-phone/missing-field top-1 rankings improved, without
recovering missing candidates. Paired counts for every scenario are in the JSON.

Wrong-identity top-1 counts were C1/MiniLM/hybrid: 40/115/47 train, 11/23/14
validation, and 9/24/9 test. Hybrid adds candidates to previously empty result
sets without recovering their true identity. No system put a wrong identity with
a detected serious contradiction first in this run. These are retrieval diagnostics,
not observed merges or a guarantee of safety on other data.

Pure semantic candidate mean/median/p95 are 20/20/20 on every split. Hybrid values
are 12.37/12/20 train, 6.96/6/11 validation, and 7.48/7/14 test, versus C1's test
6.17/6/13. All intentional no-match queries remain excluded from recall: on test,
their mean candidate counts are C1 4.67, MiniLM 20, hybrid 6.33.

The recorded cached-weight CPU run used Windows AMD64, Python 3.13.13, two PyTorch
threads, and the same AMD processor as C1. Model preparation, including imports
and loading cached weights, took 6.50 s; all query/corpus embeddings took 23.22 s.
Full benchmark runtime was 56.62 s, including metric/scenario evaluation, paired
diagnostics, five timing passes, and output writing. Initial model acquisition is
separate from these cached-weight numbers.

| Test timing component | Median ms | p95 ms |
| --- | ---: | ---: |
| C1 retrieval, remeasured | 0.332 | 0.778 |
| MiniLM exact retrieval, vectors ready | 0.113 | 0.129 |
| Hybrid retrieval/order, vectors ready | 0.866 | 1.798 |

Test query embedding took 1.260 s for 130 inputs (9.69 ms/input amortized in batches);
candidate embedding took 2.330 s for 254 inputs. The exact-search timing excludes
both. Amortized batch encoding is not single-request latency. Two independent CPU
runs re-encoded the data from cached weights and produced byte-identical logical
result files; latency files varied. Results and timing are stored separately in
`results/c2/`. No production latency claim follows from this experiment.

### Gemini live boundary and decision

The [current Google model documentation](https://ai.google.dev/gemini-api/docs/models/gemini-embedding-2)
identifies stable `gemini-embedding-2`. The live runner requests 768 dimensions
through the existing Google GenAI SDK. Following [Google's embedding instructions](https://ai.google.dev/gemini-api/docs/embeddings),
queries use `task: search result | query: ...` and documents use
`title: none | text: ...`; no legacy `task_type` is sent. Up to 64 separate `Content`
objects are sent per call, with independent output counts/dimensions validated.
This uses synchronous batched embedding, not the asynchronous discounted Batch API.

```powershell
uv run python -m benchmarks.identity_resolution.semantic_experiment --provider gemini --live-gemini --split all
```

Both the flag and configured `GEMINI_API_KEY` are required. The key was unavailable,
so the live experiment was **not executed** and `gemini-status.json` records that
limitation. No Gemini metrics, cost, or performance decision are fabricated. Unit
tests use a fake SDK client to check batching, prompt prefixes, dimensions, and caches.
The implementation records response metadata/statistics when exposed and API call
timing/counts. No dollar cost is estimated.

Gemini caches use non-pickle NumPy files outside Git, keyed by dataset fingerprint,
benchmark version, model/revision marker, dimension, serialization, task format,
role, and input text. The API stable alias exposes no immutable serving revision;
use a fresh `--cache` directory for a new live experiment rather than interpreting
old vectors as a new serving-model measurement. Spaces from different models or
generations are never mixed.

Dependency audit: pip-audit checked the installed environment and reported no known
vulnerabilities. Its PyPI service could not resolve `torch==2.14.1+cpu`; the
corresponding `torch==2.14.1` base release was audited separately with no known
vulnerabilities. This does not certify the CPU wheel itself. Wheel sources/hashes
are locked, and the model format/revision are pinned; TLS/integrity checks remain enabled.

Decision: reject this local semantic baseline and its hybrid from production
retrieval. They add no candidate coverage, increase candidate volume, and require
model operation/encoding. The isolated top-1 wins do not justify those costs or
offset the losses. Gemini performance remains unassessed until a credentialed live
run; its infrastructure is retained as an optional manual experiment only.
**Semantic retrieval is not adopted; pgvector is not justified by C2.** Production
code, matching/routing policy, database schema, deployment, and infrastructure are unchanged.
