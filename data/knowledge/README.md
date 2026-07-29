# Rangabot Knowledge Vault

Put personal learning material in `inbox/`.

Self-service ingestion flow:

1. Add PDF, DOCX, HTML, Markdown, or plain-text files to `inbox/`.
2. Run `npm run knowledge:ingest` from the Rangabot project directory.
3. The importer extracts and normalizes text locally, skips unchanged files,
   then builds keyword and embedding indexes under `indexes/`. It reports the
   active source, extraction, passage count, and every embedding batch so large
   textbooks do not appear stalled. If local embeddings time out, the compatible
   book is still saved as keyword-searchable instead of failing the entire run.
   Passages retain heading/section hierarchy and PDF page ranges. The first run
   after upgrading to ingestion format v2 re-indexes older compatible sources
   once to add this metadata.
4. Use Smart mode for automatic local retrieval or Teacher mode for citation-first
   teaching that clearly separates vault evidence from local-model background.
   Source files are never uploaded.

The doctor compares inbox file hashes with the index, so moved, unindexed,
stale, empty, and page-marker-only sources are reported. The importer identifies
documents by content hash and repairs paths after a project-folder rename instead
of duplicating the document.

Image-scanned PDFs require OCR before ingestion. Rangabot deliberately rejects
such a PDF rather than indexing empty page markers and presenting it as usable
knowledge. Run the PDF through a local OCR tool such as OCRmyPDF, keep the
searchable output in `inbox/`, and then rerun `npm run knowledge:ingest`. OCR must
remain local; no vault source should be uploaded to an online conversion service.

Useful commands:

```bash
npm run knowledge:init       # create private local directories
npm run knowledge:status     # report documents, passages and storage
npm run knowledge:validate   # validate public source metadata
npm run knowledge:backup     # save a local index snapshot
npm run knowledge:ingest     # incrementally index changed files
npm run knowledge:doctor     # diagnose an empty or full vault
npm run knowledge:rollback   # preview latest rollback; add -- --yes to confirm
```

The initial storage budget is 4 GB. Configure it with
`KNOWLEDGE_BUDGET_BYTES` before importing if this changes later.

The `inbox/`, `processed/`, and `indexes/` directories are ignored by Git. Do
not place secrets, credentials, private keys, or material you are not permitted
to copy into the vault. Backups are local and ignored too.

`SOURCE_MANIFEST.json` describes redistributable or publicly sourced starter
material; it is not an inventory of private user books. When maintaining weekly
subject intelligence, verify primary sources manually, record the event date,
why it matters, evidence class and indexing status, then run
`npm run knowledge:validate`. No Codex installation is required.
