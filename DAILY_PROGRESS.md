# Daily progress

## 2026-07-29 — Critical full-tree and GitHub audit

- Verified the public repository, branch protection, successful required CI,
  license, Discussions, Issues, secret scanning, push protection, and production
  dependency audit.
- Removed the unsafe heavy-model fallback and prohibited remote Ollama endpoints.
- Centralized and validated local runtime defaults, bounded stored/generated chat
  payloads, and added repository secret-content filtering.
- Corrected misleading evaluation summaries that treated timeouts as answer
  failures and included their timeout duration in answer latency.
- Updated the stale Discussions link, added defensive browser headers, updated
  PDF extraction, and documented unresolved findings in `docs/code-review.md`.
- Confirmed GitHub maintenance debt: the latest release trails `main` by 21
  commits, 31 remote branches remain, and automatic merged-branch deletion is off.

## 2026-07-29 — Adaptive grounding without a weaker gate

- Recorded the fresh 60-case result: 80.0% pass rate, 84.4% required-concept
  coverage, 91.7% grounding, 73.3% revision, 63.3% evidence/background
  separation, and 57.8-second mean latency. Two statistics cases timed out and
  remain retryable from the local checkpoint.
- Mapped each requested answer part to its strongest direct passage matches so
  the small local model receives a more explicit completeness checklist.
- Reordered grounding recovery: deterministic evidence/background separation
  now runs before any second generation, and the unchanged audit is rerun before
  revision can be skipped.
- Kept local revision as selective escalation for drafts that still cannot pass
  the same citation-coverage and lexical-support thresholds.
- A focused rerun of four previously failing cases passed 2/4, kept grounding at
  100%, required no second generations, and reduced mean latency to 34.4 seconds.
  Dashboard completeness and cross-mythology source synthesis still failed. A
  superficially passing leakage answer also conflated leakage with concept drift,
  exposing a terminology-reliability regression that aggregate scoring missed.

## 2026-07-29 — Evidence-planned Teacher Mode synthesis

- Used the completed 60-answer run as the baseline: 46.7% composite pass, 89%
  concept coverage, 51.7% grounding, 70% revision, and 50.6-second mean latency.
- Added deterministic subtopic and claim-to-source planning before drafting.
- Prevented a weak revision from replacing a better-grounded first draft.
- Repaired citation markers emitted as isolated paragraphs and added conservative
  citation recovery at twice the audit's lexical-support threshold.
- When mixed content still fails, separated supported vault paragraphs from
  explicitly unverified local-model background rather than hiding uncertainty.
- A fresh four-domain targeted run passed 4/4 with 100% concept and grounding
  coverage; 75% used the separation fallback and all still required revision,
  so first-draft reliability and latency remain unresolved.
- Reprocessing the original 60 saved answers through the new deterministic
  boundary raised composite pass from 29/60 to 52/60. This is a counterfactual
  re-score, not a substitute for the next fresh 60-answer run.

## 2026-07-29 — Sixty-question RAG benchmark

- Replaced the 13-question smoke test with 60 rubric-backed questions across ten
  subject groups, three difficulty levels, and explicit cross-source tasks.
- Added a complete Teacher Mode answer benchmark for concept coverage,
  grounding, forbidden claims, cited-source synthesis, revisions, and latency.
- Added per-subject and per-difficulty results while keeping answers and detailed
  reports private and Git-ignored.
- Established the honest retrieval baseline at 85%, then fixed implicit
  SQL/statistics classification and compact mythology/ML source titles.
- The same 60 questions now score 90% retrieval pass, 99.2% expected-source
  coverage, 100% contamination-free, and 98% passage-locator coverage.
- Remaining retrieval failures are concentrated in multi-book coverage and one
  cross-domain statistics-plus-visualization synthesis query.
- Hardened the long answer run after a 120-second generation timeout stopped at
  question 8: evaluation calls now allow five minutes, checkpoint every answer,
  continue after isolated errors, and resume only unfinished cases.
- A ten-subject generated-answer sample initially passed 60%, with 90.8%
  required-concept coverage, 70% grounding, 40% revision, and 61.6-second mean
  latency on `llama3.2:3b`. This is the first honest synthesis baseline, not a
  full 60-answer claim.
- The sample exposed bare `[N]` citations, overly broad background-section
  auditing, irrelevant-passage distraction, and weak evidence for a basic
  mean-versus-median question. Citation normalization and evidence-selection
  instructions were hardened; deterministic rescoring raised the same saved
  sample to 80%, while targeted generation confirmed supervised learning now
  passes and mean-versus-median remains a real unresolved quality gap.

## 2026-07-29 — Teacher Mode grounding review

- Added deterministic checks for substantive citation coverage, invalid source
  numbers, and weak lexical support between claims and cited passages.
- Added one bounded local-model revision when the first answer fails grounding.
- Added a visible warning when the revised answer still cannot meet the
  grounding threshold rather than presenting uncertain claims as verified.
- Preserved explicit Local model background sections without requiring false
  vault citations and kept ordinary/Smart chat streaming unchanged.
- Verified the full local route: a weak cross-validation draft was revised and
  returned with `revised-and-passed` in about 27 seconds on `llama3.2:3b`.

## 2026-07-29 — Measurable RAG retrieval quality

- Added a local evaluation harness so retrieval changes must demonstrate useful
  source selection instead of relying on anecdotal chat outputs.
- Added 13 starter questions across Python, SQL, PySpark, NumPy, pandas, machine
  learning, visualization, and three mythology traditions.
- Measured expected-source coverage, cross-subject contamination, source
  diversity, passage locators, and p50/p95 latency without exporting vault data.
- Kept personal textbook cases and detailed reports in explicit Git-ignored
  locations while retaining a reusable public starter suite.

## 2026-07-29 — Native local vector search

- Added a compact `sqlite-vec` table inside the private Knowledge Vault database
  for exact cosine search over existing local embeddings.
- Added automatic stale-index detection, rebuild after vault changes, an
  explicit rebuild command, and fallback to the previous JavaScript search.
- Indexed 17,986 768-dimensional passage vectors in 10.2 seconds, adding about
  54 MB to the local vault database.
- Reduced a 12-query, three-concurrent-batch mixed-subject stress run from
  31.6 seconds to 17.8 seconds. Native vector lookup itself measured about
  24 milliseconds; local query-embedding generation is now the main bottleneck.

## 2026-07-29 — Subject-aware retrieval guard

- Stress-tested 37,094 passages across statistics, ML, Python, SQL,
  visualization, and mythology queries.
- Added local subject inference for major Rangabot teaching domains.
- Excluded clearly cross-domain titled sources before final evidence diversity,
  while preserving relevant and uncategorized books.
- Added a regression case preventing Fluent Python from entering clustering
  evaluation evidence.

## 2026-07-29 — Accurate Knowledge Vault doctor result

- Corrected the doctor command so known incompatible files are reported as an
  informational notice rather than incorrectly classified as unindexed work.
- A healthy searchable vault now passes even when deliberately skipped sources
  remain in the inbox for user review.

## 2026-07-29 — Hierarchical Knowledge Vault ingestion

- Added a backward-compatible SQLite migration for passage heading, section
  path, and PDF page-range metadata.
- Added versioned ingestion so older compatible sources re-index once without
  requiring the user to delete or rebuild the vault manually.
- Preserved DOCX and HTML heading levels, Markdown headings, common plain-text
  chapter labels, and PDF page boundaries during chunking.
- Prevented overlap text from crossing section boundaries and contaminating a
  new section's metadata.
- Added hierarchy metadata to retrieval results and source labels supplied to
  Teacher and Smart modes.

## 2026-07-28 — Visible textbook-ingestion progress

- Added per-source progress before reading each Knowledge Vault file.
- Added visible extraction size, passage count, and embedding-batch progress for
  large textbooks.
- Added a two-minute timeout per Ollama embedding batch so ingestion cannot wait
  forever on an unresponsive local model.
- Compatible files fall back to a keyword-searchable index when embeddings are
  temporarily unavailable; rerunning ingestion can add embeddings later.

## Next approved milestone — Rangabot Learning Core

Rangabot will grow from a retrieval-assisted chatbot into a local knowledge
synthesizer. Retrieval remains an internal evidence tool; the user-facing result
must be an original, context-aware explanation built from the downloaded model,
multiple compatible books, and the relevant conversation.

### Approved capability backlog

1. Preserve document hierarchy during ingestion: book, chapter, section,
   heading, page, and passage.
2. Plan each knowledge request using its intent, subject, conversation context,
   and the user's demonstrated level.
3. Gather and rerank evidence across multiple books, then identify overlap,
   complementary explanations, and genuine source disagreements.
4. Synthesize a coherent answer using both cited vault evidence and clearly
   labelled local-model background instead of reproducing retrieved passages.
5. Add inspectable local learning memory for preferences, proficiency, progress,
   corrections, and user-approved conclusions.
6. Run a separate grounding and completeness review before returning important
   answers, revising weak drafts when necessary.
7. Build reusable cross-book concept summaries and relationships that can be
   regenerated whenever the vault changes.
8. Capture explicit feedback and corrections as reviewable quality signals and
   regression fixtures so improvement is measured rather than assumed.

### Learning and safety contract

- All source processing, memories, evaluations, and synthesis remain local.
- Every durable learned item records its origin, confidence, and update time.
- Conflicting interpretations remain visible rather than being silently merged.
- Users can inspect, edit, export, reject, and delete learned memories.
- Adding books updates the knowledge layer; it does not automatically retrain or
  mutate model weights.
- Fine-tuning may later be offered only from a reviewed, explicitly approved
  dataset with evaluation and rollback.

### First implementation slice

Start with hierarchical ingestion and source-aware multi-book retrieval. This is
the required foundation for later concept synthesis, persistent memory, and
quality evaluation, and it can be validated without changing model weights.

## 2026-07-28 — Knowledge Vault retrieval repair

- Found that the live index still referenced the pre-rename `/wan/` folder and migrated 23 records by content hash without duplicating their chunks.
- Fixed conversational stop-word pollution and BM25 score flattening; added title-aware hybrid reranking and a semantic relevance floor.
- Expanded answer context from three to five reranked passages and instructed Teacher Mode to ignore irrelevant evidence instead of discussing it.
- Made `knowledge:doctor` report unindexed, moved, stale, and textless sources.
- Added ingestion quality gates that reject empty HTML and image-scanned PDFs instead of indexing page-number markers.
- Verified live retrieval across Ramayana, Python namespaces, pandas, Egyptian mythology, and Greek mythology.
- Identified `valmiki_ramayanam.pdf` as a 339-page image-only scan. It now remains visibly unindexed until local OCR is available, instead of contaminating answers.

## 2026-07-28 — Word story quality hardening

- Reproduced the poor Ramayana document and traced it to a generic business-report fallback.
- Added story-collection, guide, and article genres plus warm/playful tones.
- Added hard gates that reject planning notes, source dumps, incomplete stories, and generic report scaffolding.
- Added story-specific Word rendering without the business purpose/audience table.
- Added a curated local Ramayana pack covering Rama's exile, Bharata's sandals, Hanuman's journey to Sita, and Jatayu's courage so `llama3.2:3b` cannot invent plot outcomes.
- Verified the exact chat scenario end-to-end. The resulting two-page DOCX contains four complete stories and was rendered to PNG for visual inspection.
