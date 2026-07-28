# Daily progress

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
