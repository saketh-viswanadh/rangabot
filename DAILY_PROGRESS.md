# Daily progress

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
