# Identity resolution benchmark (C1-C4)

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

Recorded results: [train](../backend/benchmarks/identity_resolution/results/train.json),
[validation](../backend/benchmarks/identity_resolution/results/validation.json),
[test](../backend/benchmarks/identity_resolution/results/test.json).

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

Recorded results: [MiniLM test](../backend/benchmarks/identity_resolution/results/c2/local-test.json),
[hybrid test](../backend/benchmarks/identity_resolution/results/c2/local-hybrid-test.json),
[runtime](../backend/benchmarks/identity_resolution/results/c2/local-runtime.json).

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

## C3 learned candidate ranking

Recorded results: [Logistic test](../backend/benchmarks/identity_resolution/results/c3/logistic-test.json),
[XGBoost test](../backend/benchmarks/identity_resolution/results/c3/xgboost-test.json),
[feature investigation](../backend/benchmarks/identity_resolution/results/c3/feature-investigation.json),
[selection veto](../backend/benchmarks/identity_resolution/results/c3/selection.json).

C3 trains pair classifiers on exactly C1's deterministic top-20 candidate sets.
Each query/candidate receives one model score, then sorts by descending score and
opaque record ID. Truth supplies the binary label only. Identity groups and all
candidate records stay inside their original partition. The runner verifies the
frozen manifest and all C1 logical results before fitting; C2 files are untouched.

From `backend/`, without model downloads, external APIs, databases or brokers:

```powershell
uv sync --frozen --group ranking-benchmark
uv run --frozen --group ranking-benchmark python -m benchmarks.identity_resolution.ranking_experiment
uv run --frozen --group ranking-benchmark python -m benchmarks.identity_resolution.ranking_experiment --challenger --held-out
```

The default evaluates Logistic train/validation only. `--challenger` adds XGBoost;
`--held-out` scores test after configuration selection and the validation feature
audit are recorded. `--output` supports a separate reproducibility run. Parameters,
versions, feature order, metrics, coefficient/gain explanations, validation-only
distributions and timing are in `results/c3/`. There are no pickle files, model
caches, production loaders or model registry. The Logistic JSON contains our fitted
coefficients, intercept and scaler; XGBoost is reproduced by retraining its fixed
configuration. Outputs are uncalibrated candidate scores, not identity probabilities.

### Features and fitting

Schema `c3-structured-components-v1` has 19 features in an explicit stable order:
five existing matcher components (name, exact email, exact phone, employer,
geography), normalized full/first/last-name token similarity, middle-initial
agreement, suffix agreement, five field-missing indicators, and the existing suffix,
full-middle-name, employer and geography contradiction flags. Missing means either
side lacks usable evidence, using the matcher's existing definition. Explicit name
parts take precedence over parsed parts. The final deterministic aggregate score,
source constants, contact substrings, notes, truth, scenarios, split labels,
embeddings and Gemini outputs are excluded. No aggregate-score ablation is needed.

| Split | Pairs | Positive | Negative | Negative/positive |
| --- | ---: | ---: | ---: | ---: |
| Train | 6,900 | 1,175 | 5,725 | 4.87 |
| Validation | 719 | 253 | 466 | 1.84 |
| Test | 802 | 251 | 551 | 2.20 |

[Official PyPI](https://pypi.org/project/scikit-learn/) verified scikit-learn 1.9.1
as stable and compatible with Python 3.13. Logistic uses a train-fitted
`StandardScaler`, L2, `lbfgs`, `max_iter=2000`, seed `20261001`. Six validation runs
compare C=0.1/1/10 with ordinary/balanced class weights. Ranking safety and MRR lead
selection; false pairs scoring at least 0.9 break ties, then the first configuration
wins an exact tie. The chosen configuration is C=0.1, ordinary class weights. No
oversampling or extra synthetic pairs are used; models remain fitted on train.

[XGBoost PyPI](https://pypi.org/project/xgboost/) verified stable 3.4.1. The
[official CPU variant](https://xgboost.readthedocs.io/en/stable/install.html#minimal-installation-cpu-only)
is pinned to `xgboost-cpu==3.4.1` on Windows/Linux, avoiding CUDA/NCCL packages; other
platforms use `xgboost==3.4.1` with CPU execution. One `XGBClassifier` challenger
uses binary logistic, CPU hist, one thread, depth 3, up to 200 trees, learning rate
0.05, min child weight 5, lambda 5, alpha 0.1, full row/column sampling and the same
seed. Validation log loss supports 20-round early stopping; best iteration was 199,
so all 200 trees were used. `scale_pos_weight=1`: ordinary Logistic weights already
worked on the 4.87:1 training ratio, so no XGBoost imbalance search was warranted.

### Ranking and safety measurements

These recall/MRR denominators include all eligible queries, preserving C1's
definition. Artifacts also report metrics conditional on a true candidate being
available. Candidate-generation misses stay 7/3/0 for train/validation/test;
the learned models cannot recover them. No-match queries (14/3/3) are separate.

| Split / ranker | Recall@1 | Recall@5 | Recall@10 | MRR | Wrong identity top-1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Train / C1 | 92.19% | 98.50% | 98.84% | 0.95314 | 40 |
| Train / Logistic | 96.18% | 98.84% | 98.84% | 0.97370 | 16 |
| Train / XGBoost | 96.18% | 98.84% | 98.84% | 0.97370 | 16 |
| Validation / C1 | 89.31% | 97.71% | 97.71% | 0.93384 | 11 |
| Validation / Logistic | 94.66% | 97.71% | 97.71% | 0.96056 | 4 |
| Validation / XGBoost | 94.66% | 97.71% | 97.71% | 0.96056 | 4 |
| Test / C1 | 92.91% | 100% | 100% | 0.95932 | 9 |
| Test / Logistic | 97.64% | 100% | 100% | 0.98688 | 3 |
| Test / XGBoost | 97.64% | 100% | 100% | 0.98688 | 3 |

Raw and contradiction-aware model ranking have the same aggregate results in this
run. The gate demotes blocked records while retaining them in recall/scenario
analysis, and excludes them from threshold-positive decisions even if all records
are blocked. Neither learned model puts a blocked wrong identity first or gives a
blocked false pair a score of at least 0.5. Tests inject scores of 1 into Jr/Sr and
full-middle conflicts to verify that a score cannot bypass the existing hard gate.
An unblocked top candidate still does not establish a safe automatic match.

Pair metrics below use the fixed diagnostic probe 0.5, with official scikit-learn
metrics; raw and gated values agree for both models. These probes are not proposed
production thresholds. Pair accuracy is not the primary measure.

| Split / model | Precision | Recall | F1 | TP / FP / FN / TN |
| --- | ---: | ---: | ---: | --- |
| Train / Logistic | 94.77% | 86.38% | 90.38% | 1015 / 56 / 160 / 5669 |
| Validation / Logistic | 94.83% | 86.96% | 90.72% | 220 / 12 / 33 / 454 |
| Test / Logistic | 94.35% | 86.45% | 90.23% | 217 / 13 / 34 / 538 |
| Train / XGBoost | 91.53% | 91.91% | 91.72% | 1080 / 100 / 95 / 5625 |
| Validation / XGBoost | 91.76% | 92.49% | 92.13% | 234 / 21 / 19 / 445 |
| Test / XGBoost | 89.49% | 91.63% | 90.55% | 230 / 27 / 21 / 524 |

At 0.9, Logistic false-positive pair counts are 14/3/3; XGBoost counts are 0/0/0.
At 0.99 both have zero false-positive pairs, with lower recall. C1's aggregate score
divided by 100 has zero gated false-positive pairs at 0.9, but its held-out pair
recall there is 61.35%, versus Logistic 76.49% and XGBoost 66.93%. Those scores have
different scales; equal numeric probes are not equivalent operating points. A
zero count on this synthetic sample does not establish a production-safe threshold.
All three test no-match queries have Logistic top score 0.49527 and XGBoost 0.51515.
XGBoost would therefore classify no-match pairs positive at 0.5. The later C4
evaluation below retains deterministic ranking and thresholds 75/45.

Both learned models show eight held-out top-1 wins and two losses versus C1. Primary
scenario recall rises for malformed fields (0% to 100%, n=3), ambiguity (33.33% to
100%, n=3), transliteration (66.67% to 100%, n=3), stale phone (77.78% to 100%, n=9),
and overlapping employer/geography change (66.67% to 100%, each n=6). Exact-duplicate
recall falls from 98.53% to 95.59% (n=68), including easy linked-anchor queries.
Namesakes stay 94.34% (n=53) with two wins and two losses. Suffix conflicts, full
middle conflicts, household phone, nicknames, middle initials, marriage/name change,
stale email and missing fields retain their C1 top-1 results. Scenario samples are
small and overlap; the apparent gains require the feature audit below.

### Feature audit and decision

Logistic's largest standardized coefficients are email exact +1.91, phone exact
+1.55, missing geography -1.20, suffix conflict -1.18 and first-name similarity
+1.08. Employer missing is +0.47 and geography agreement is unexpectedly negative
(-0.82). XGBoost's normalized gain is led by email exact (45.1%), phone exact
(12.4%), suffix conflict (11.5%) and full-middle conflict (8.7%). Importance is not
causality, and correlated features make individual coefficients difficult to
interpret independently.

Inspection found a predictive construction pattern: C1's primary identity gets a
partial provider observation missing phone/employer, while the linked identity
gets one missing geography. Every recovered validation query for each model (9/9)
separates its highest-ranked true observation from its best false observation only
through those omissions and their effect on component/conflict values. The feature
audit records the exact differing feature names for each recovery. This is not
truth-ID or split leakage; it is an accidental association between record
completeness and identity ownership within a synthetic group.

Three train-fitted, validation-only Logistic ablations investigate the association
without changing the chosen model or scoring any test pairs: masking five explicit
missing indicators retains 94.66% Recall@1 because components still encode missing
evidence; masking geography signals gives 93.89%; masking missing indicators and
employer/geography signals falls to C1's 89.31%. Name/contact agreement and hard
name conflicts alone do not reproduce the claimed improvement. Missingness can be
useful on real records, but this benchmark's fixed omission pattern does not support
an identity conclusion.

The numeric validation rule initially prefers Logistic: seven net top-1 wins with
better MRR and fewer wrong identities, while XGBoost adds no ordering benefit and
has more false pairs at 0.5. The validation feature audit vetoes both. **Keep
deterministic ranking.** Reject Logistic's apparent improvement as dependent on the
synthetic observation pattern; reject XGBoost for the same reason plus its additional
complexity without ranking benefit. This is a benchmark limitation, not incorrect
labels or partitions requiring C1/C2 regeneration. C3 changes neither the frozen
data nor production behavior. A future independently designed evaluation would be
needed before reconsidering a learned ranker; it is outside C3.

### Reproduction, dependencies and timing

The isolated CI ranking job installs only the optional `ranking-benchmark` group
and checks ML isolation, deterministic ordering, train-only preprocessing, label
correctness, reproducible fits and hard gates. Ordinary API CI remains offline and
uses existing dependencies. The lock inspection found no existing package version
changes; only the two platform-specific official XGBoost distributions were added.
Scikit-learn and its transitives already existed in the C2 optional lock. A
pip-audit 2.10.1 audit of 97 applicable locked runtime/dev/ranking packages found no
known vulnerabilities; frontend npm audit also found zero. The audit excludes the
uninstalled semantic group and does not certify packages against unknown flaws.
Official wheels, lock hashes, TLS and integrity checks remain in use.

Timing separates feature extraction, model scoring and contradiction-aware sorting
for each local query batch, with five passes after warmup. Candidate generation is
excluded; C1's separate timing includes normalization, blocking and ordering. These
are Windows AMD64/Python 3.13.13 local measurements, not production latency. Exact
medians/p95 and selected fit times are in `results/c3/latency.json`. Independent
fixed-seed runs reproduce logical artifacts; timings vary.

| Test query batch / component | Median ms | p95 ms |
| --- | ---: | ---: |
| Logistic / feature extraction | 0.514 | 1.252 |
| Logistic / model scoring | 0.297 | 0.386 |
| Logistic / sorting | 0.013 | 0.019 |
| XGBoost / feature extraction | 0.549 | 1.315 |
| XGBoost / model scoring | 0.316 | 0.477 |
| XGBoost / sorting | 0.014 | 0.023 |

Selected fits took 0.0147 s for Logistic and 0.1276 s for XGBoost, excluding feature
generation and search. Sixteen logical JSON artifacts matched byte-for-byte on a
fresh fixed-seed run; timing and the separately executed dependency audit are
excluded from that comparison. Final local verification: 125 pytest tests passed,
one existing PostgreSQL/Redis/Celery integration test skipped without its services;
Ruff, format checks, mypy for the app and new experiment modules, and frontend
lint/typecheck/build passed. The ordinary dependency set also passed 115 tests with
the ML module and service-dependent integration test skipped. The existing real
service CI job remains in place. C3 commit `7379ce02335337a05761103359e50ae7d910bf51`
was pushed to `origin/productization/v1`; authenticated remote CI inspection was
unavailable. Remote C3 CI remains unconfirmed.

## C4 contradiction-aware routing and threshold evaluation

Recorded results: [held-out routing](../backend/benchmarks/identity_resolution/results/c4/test.json),
[gate analysis](../backend/benchmarks/identity_resolution/results/c4/analysis.json),
[threshold selection](../backend/benchmarks/identity_resolution/results/c4/selection.json).

**Decision C: retain production thresholds and require future real-data calibration.**
Production remains at 75 for `LIKELY_MATCH` and 45 for `NEEDS_REVIEW`.
The frozen synthetic benchmark supports useful automatic coverage with zero observed
unsafe automatic matches, but does not provide enough independent evidence to lower
production thresholds. This is an offline experiment; no runtime policy changes.

### Current code and evaluation semantics

Scores remain capped at 100: name 30, exact email 25, exact phone 25, employer 10,
location 10. Name variation awards 20 or 10; similar employer awards 6; same state
awards 5. Missing/different evidence awards zero. C4 changes neither these weights
nor normalization, the seed, scenarios, partitions, candidate generator or ranker.

The production router selects the maximum-score candidate, retaining the first
input on ties. At score >=75, a serious contradiction forces `NEEDS_REVIEW`;
otherwise it returns `LIKELY_MATCH`. Scores >=45 and <75 go to review, lower scores
and empty candidate sets return `NO_RELIABLE_MATCH`. There is no margin gate.
Suffix conflicts (including Jr/Sr and II/III) and incompatible full middle names
are the only hard contradiction classes. Employer and state differences are
moderate, nonblocking warnings. Email/phone differences lose agreement points but
are not implemented hard identifier contradictions.

C1 supplies its unchanged bounded candidate list ordered by blocking flag, score,
then opaque ID. The router's maximum-score selection is evaluated explicitly rather
than assuming C1's first candidate is the routing choice. The application service
normally supplies score/provider-ID order; C4 preserves the C1 input and its stable
tie order. C4 records this distinction without changing either architecture.

A safe auto requires the selected identity to be correct and free of hard
contradictions. An unsafe auto is a wrong selected identity **or** a blocked
selected candidate, even if its identity is correct. Review is acceptable for
ambiguity, conflict or weak evidence; existence of a true candidate does not label
review as incorrect. Rejection of a corpus-true query is reported as a false
no-match identity diagnostic, not proof that an automatic merge was warranted.
Intentional no-match queries are counted separately. Wrong and unsafe auto rates
use both all automatic decisions and all queries as denominators. Empty automatic
denominators yield null rather than an invented zero rate.

### Baseline and frozen-policy results

| Split | Queries | Safe auto / rate | Review / rate | No reliable match / rate | Unsafe auto |
| --- | ---: | ---: | ---: | ---: | ---: |
| Train | 616 | 465 / 75.49% | 116 / 18.83% | 35 / 5.68% | 0 |
| Validation | 134 | 100 / 74.63% | 25 / 18.66% | 9 / 6.72% | 0 |
| Held-out test | 130 | 99 / 76.15% | 25 / 19.23% | 6 / 4.62% | 0 |

All automatic identities are correct. Wrong and unsafe rates are respectively
0/465 and 0/616 on train, 0/100 and 0/134 on validation, 0/99 and 0/130 on test.
Review/abstention rates are 24.51%, 25.37%, and 23.85%. Review contains 75/14/17
correct selected identities and 41/11/8 wrong selected identities; 102/22/22 review
queries still have a retrieved correct candidate. No selected top has a hard
contradiction, so observed query-level contradiction-blocked auto counts are zero.
That does not mean the gates are dispensable; the pair/probe checks below exercise them.

All 35/9/6 rejected queries have a true candidate in the full partition corpus:
false no-match rates are 35/602 (5.81%), 9/131 (6.87%), 6/127 (4.72%). Of these,
28/6/6 also have a true candidate in the retrieved set: 28/595 (4.71%), 6/128
(4.69%), 6/127 (4.72%). The 7/3/0 retrieval misses remain unchanged.

The intentional no-match counts are 14/3/3. Every one has top score 50 and goes to
review; none auto-match, and none is automatically rejected. Score 50 also occurs
for true weak/ambiguous matches. A top-score cutoff alone does not separate these
cases. Raising review to 55 rejects all three validation no-match queries, but
raises corpus-true rejections from 9 to 24. C4 does not force a candidate or claim
that routing to review establishes an identity.

### Validation search, distributions and robustness

Only train and validation routing outcomes enter development. A 20-policy grid
compares likely thresholds 65/70/75/80/85 and review thresholds 40/45/50/55.
The lexicographic rule minimizes validation unsafe autos, maximizes safe autos,
minimizes corpus-true rejections, then prefers proximity to 75/45, followed by stable
numeric ordering. Review is acceptable; it is not assigned a subjective cost or
labeled unnecessary from identity truth alone. No F1 or overall accuracy objective
is used. Thresholds must satisfy 0 <= review < likely <=100.

Every searched policy has zero observed unsafe validation autos. The numeric
winner, and best observed zero-unsafe policy within this grid, is 70/40: train
469/133/14, validation 101/28/5 (auto/review/rejection). The extra validation auto
is one transliteration query at score 70: email/phone 25 each, employer/location
10 each, name zero. Four score-40 queries move from rejection to review: three
missing-fields cases and one malformed case; two of their selected identities are
wrong. This is a small coverage gain with no measured safety improvement.

The adoption decision was frozen at **75/45 before held-out routing evaluation**.
The numeric 70/40 challenger was also frozen for one held-out comparison: it yields
100/29/1, with zero observed unsafe autos and all three no-match queries still in
review. It adds one auto and five reviews over production. Those test outcomes
were not used to revise the decision or search another policy. Subsequent runs
only check logical reproducibility.

Nearest-rank train/validation score summaries are stored in `analysis.json`. True
pair medians are 90, maxima 100; false pair medians are 16/20, maxima 90. Hard
contradiction pair medians are 70/80 and maxima 90. Selected wrong tops have median
50, p95 55 and maximum 55 on both development splits; selected true tops have
median 100, minimum 20. Ambiguous and no-match tops are all 50. Retrieved
missing-fields tops are all 40. Strong false pairs overlap true scores, so score
alone cannot replace gates. Selection did not inspect test distributions.

Neighborhood checks move one threshold at a time by one point (0.01 on a 0..1
score scale). All train/validation neighbors of both policies preserve zero unsafe
autos. For production, likely 74/75 keeps 100 validation autos; 76 drops to 91.
Review 44/45 keeps 9 rejections; 46 raises them to 15. For 70/40, likely 69/70
keeps 101 autos; 71 drops to 100; review 39/40 keeps 5 rejections, 41 raises them
to 9. Safety does not collapse, but gains sit on discrete boundaries and do not
establish a broad, independently calibrated optimum.

A top-two margin was inspected without searching or adding a margin policy.
Three validation automatic queries have zero margin because both leading provider
observations are true. Three ambiguous queries also have zero margin, but are
already in review. With baseline unsafe autos already zero, a raw margin gate adds
no observed safety benefit and confuses duplicate observations with rival identities.

### Contradictions and scenario findings

Isolating each retrieved candidate tests what happens when it is the only available
record. At production threshold, high-scoring wrong suffix pairs number 72/18/18;
high-scoring wrong full-middle pairs number 23/6/6 (train/validation/test). All go
to review, none to automatic match. These are counterfactual pair gate opportunities,
not extra query-level merges prevented. The synthetic benchmark often includes a
true score-100 observation that wins over the contradictory distractor.

Separate adversarial Arthur Pendelton Jr/Sr and II/III probes score 90; conflicting
Alexander/Anthony full-middle names score 80 despite exact contact agreement. All
remain in review when their score is artificially set to 100. Tests cover the
current and alternative policies. The eight production demo cases keep their exact
scores/routes, including Arthur's score-90 review. Moderate employer/geography
differences can coexist with automatic matches, as designed.

The held-out scenario groups overlap; counts below are not additive:

| Scenario | Auto / review / rejection | Finding |
| --- | ---: | --- |
| Exact duplicates | 65 / 3 / 0 | Three linked-anchor queries require review |
| Stale phone; stale email | 3 / 6 / 0; 3 / 3 / 0 | Review preserves weak/context-change cases |
| Nickname; marriage/name change | 0 / 3 / 0 each | Correct tops reviewed |
| Middle initial | 3 / 0 / 0 | Correct automatic identities |
| Full-middle conflict; Jr/Sr; II/III | 3 / 0 / 0 each | True unblocked records win; distractor gates pass separately |
| Employer change; geography change | 3 / 3 / 0 each | Two reviewed wrong tops in each overlapping group |
| Shared household phone | 3 / 0 / 0 | No observed unsafe auto |
| Namesakes | 44 / 12 / 0 | Six reviewed wrong tops, including no-match queries |
| Ambiguous | 0 / 3 / 0 | Two reviewed wrong tops, no forced auto |
| Transliteration | 1 / 1 / 1 | Sparse evidence can be rejected |
| Missing fields; malformed | 0 / 0 / 2; 0 / 0 / 3 | Five of six corpus-true rejections |

Missingness analysis reports explicit scenario membership, any missing query field,
missing evidence on the selected pair, and complete queries separately. C3's
asymmetric provider omissions remain frozen; thresholds neither re-rank candidates
nor learn completeness. The extra validation auto has no missing evidence, so it
is **not** the C3 missing-field-only recovery artifact. Three of four extra review
cases do depend on the explicit missing-fields scenario, and their truth does not
make weak name/location evidence reliable. Both limitations support retaining the
current policy rather than claiming artifact-independent calibration.

### Reproduction and verification

From `backend/`, no external services or optional ML dependencies are required:

```powershell
uv sync --frozen
uv run --frozen python -m benchmarks.identity_resolution.routing_experiment
uv run --frozen python -m benchmarks.identity_resolution.routing_experiment --held-out
```

Development writes the selection freeze first. Held-out mode requires that freeze
to match before constructing test routing cases; it cannot overwrite selection.
Use `--output ../.system_generated/c4-repeat` with both commands for reproduction.
`results/c4/` contains the manifest, compact grid/selection, development distributions,
neighborhood/missingness/margin audits, gate probes/demo checks, and per-split routing
reports. The runner verifies the frozen C1 manifest and logical retrieval outputs,
and records SHA-256 hashes for every pre-C4 C1/C2/C3 JSON artifact, including timing.
C1/C2/C3 artifacts remain untouched. No new dependency, CI change, production
infrastructure change, ML model or semantic score is introduced.

Local verification passed 151 tests with the existing optional ranking test group;
one service-dependent integration test was skipped. The ordinary frozen dependency
set passed 141 tests, with that integration test and the optional ML test module
skipped; all 26 C4 tests ran. Ruff, formatting, mypy for the app and C4 modules, and
frontend lint/typecheck/build passed. All six C4 JSON artifacts matched byte-for-byte
on an independent run. The unchanged 96 applicable locked runtime/dev/ranking
packages passed pip-audit with no known vulnerabilities; npm audit reported zero.
The optional semantic group was not audited in C4. Lockfiles are unchanged.

Zero observed unsafe automatic matches on this finite synthetic validation or test
benchmark is not a real-world false-merge guarantee. Independently collected,
reviewer-labeled real data with hard conflicts, contact reuse and balanced missingness
is needed before production calibration. Remote C3 CI remains unconfirmed.
