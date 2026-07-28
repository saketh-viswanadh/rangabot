# Data science intelligence brief

## Week of 2026-07-27

Only meaningful, source-verified developments belong here. This is a subject brief—not a Rangabot changelog.

### Data tools and libraries

#### DuckDB 1.5.5 strengthens correctness and local analytics

- **Event date:** 2026-07-22
- **What changed:** DuckDB released 1.5.5 with correctness fixes, crash fixes, security patches, Arrow interoperability fixes, and targeted performance work.
- **Why it matters:** DuckDB is widely useful for running analytical SQL directly on local files. Reliability fixes around decimals, aggregates, external hashing, schema changes, and Arrow reduce risk in notebook and embedded analytics workflows.
- **Evidence:** Primary source — [DuckDB 1.5.5 announcement](https://duckdb.org/2026/07/22/announcing-duckdb-155)
- **Vault status:** Release evidence indexed; broader DuckDB learning material added for offline retrieval.

#### pandas 3.0.5 is the current maintenance release

- **Event date:** 2026-07-22
- **What changed:** pandas published 3.0.5, a maintenance release focused on regressions. The important learning context remains the pandas 3.0 series, which introduced compatibility-impacting changes compared with 2.x.
- **Why it matters:** Production data pipelines should test before upgrading across the 2.x-to-3.x boundary; patch releases improve stability but do not remove the need for migration checks.
- **Evidence:** Primary source — [pandas release notes](https://pandas.pydata.org/docs/whatsnew/)
- **Vault status:** Current release index and 3.0-series notes indexed locally.

### Machine learning systems

#### PyTorch 2.13 improves Apple Silicon and memory-efficient training

- **Event date:** 2026-07-08
- **What changed:** PyTorch 2.13 brought FlexAttention to Apple Silicon, added a CuTeDSL backend for Inductor, introduced a fused linear-plus-cross-entropy operation, and expanded distributed-training and on-device inference capabilities.
- **Why it matters:** The release is relevant to local AI on Macs and to efficient model training. PyTorch reports up to roughly 12x speedup for sparse FlexAttention patterns on Apple Silicon and up to 4x lower peak GPU memory for the fused large-vocabulary loss path; these are workload-specific project claims, not universal benchmarks.
- **Evidence:** Primary source — [PyTorch 2.13 release](https://pytorch.org/blog/pytorch-2-13-release-blog/)
- **Vault status:** Source tracked in the brief; full framework documentation is not yet indexed.

### Numerical computing

#### NumPy 2.5 changes the supported Python baseline

- **Event dates:** 2026-06-21 (2.5.0), 2026-07-04 (2.5.1)
- **What changed:** NumPy 2.5 removed distutils, dropped Python 3.11 support, improved free-threading support and static typing, and added descending sorts aligned with the Array API standard. Version 2.5.1 followed as a bug-fix release.
- **Why it matters:** Teams moving to NumPy 2.5 need Python 3.12–3.14 and should check build and packaging assumptions. The Array API work also improves portability of array-oriented code across compatible libraries.
- **Evidence:** Primary source — [NumPy news and releases](https://numpy.org/news/)
- **Vault status:** Official NumPy 2.5 User Guide indexed locally.

### Watchlist

- **Lightweight models:** No new model is promoted this week without a primary model card, license, reproducible evaluation evidence, and a realistic fit for local hardware.
- **New algorithms:** No single new algorithm met the evidence threshold for inclusion this week. Research preprints will be labeled as preprints and kept separate from production-ready recommendations.
