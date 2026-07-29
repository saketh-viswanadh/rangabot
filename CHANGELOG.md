# Changelog

All notable Rangabot changes are documented here using
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) principles. This file
records the complete product journey; `DAILY_PROGRESS.md` contains implementation
notes and `ROADMAP.md` separates approved, proposed, and decision-dependent work.

## Unreleased

### Added

- Conversational Word creation inside ordinary chat. Rangabot gathers missing
  requirements, uses the local model to draft finished content, applies
  deterministic DOCX formatting, stores artifacts privately, renders previews,
  and presents an in-chat download link.
- Genre-aware Word output for reports, proposals, meeting notes, technical
  briefs, guides, articles, and children's story collections.
- Conversation-to-Word summaries that incorporate both user questions and
  Rangabot's substantive answers rather than reproducing requirement prompts.
- A shared artifact-quality foundation for future PDF, email, long-form writing,
  technical-documentation, presentation, and spreadsheet abilities.
- An explicit local repository allowlist with canonical-path validation,
  revocation, scoped text search, bounded line-numbered previews, and visible
  code-context attachment to local-model requests.
- Local conversation search, persistent pinning, Markdown export, and restore.
- A dedicated Knowledge Brief experience with weekly intelligence cards,
  monthly archives, vault status, and meaningful subject updates.
- A 300-item offline welcome library containing 100 quotes, 100 jokes, and 100
  thoughts, with a browser-local 60-item no-repeat window.
- Source-state reporting for indexed, pending, and incompatible Knowledge Vault
  files, including visible filenames and reasons requiring attention.
- Portable content-hash vault synchronization so indexed books survive a local
  project-folder or repository rename without duplicate passages.
- Versioned hierarchical ingestion preserving section paths, headings, and PDF
  page ranges on passages, with automatic in-place SQLite migration.
- The approved Rangabot Learning Core roadmap: hierarchical book understanding,
  conversation-aware planning, multi-book synthesis, inspectable local memory,
  grounding review, cross-book concept summaries, and feedback-based evaluation.
- A compact native `sqlite-vec` index for existing local embeddings, including
  an explicit `knowledge:vector-index` rebuild command.
- A privacy-preserving local retrieval evaluation harness with reusable starter
  cases, private vault-specific fixtures, timestamped reports, and measurable
  relevance, contamination, diversity, locator, and latency results.
- A Teacher Mode grounding gate that audits citation coverage, citation numbers,
  and lexical support before returning an answer, revises weak drafts once
  locally, and warns visibly when the revision remains insufficiently grounded.

### Changed

- Smart Mode and Teacher Mode now treat retrieval as evidence gathering rather
  than the final response. Vault evidence is combined with relevant conversation
  context and clearly distinguished background from the downloaded local model.
- Teacher Mode is citation-first rather than passage-only: it may teach beyond an
  incomplete vault using labelled local-model background while preserving gaps,
  uncertainty, historical interpretations, and mythology variants.
- Knowledge retrieval now cleans conversational filler, weights source titles,
  combines keyword and semantic relevance, reranks results, removes duplicates,
  and applies a relevance floor before evidence reaches the model.
- Relevant evidence is diversified across matching books before prompt assembly;
  weak sources remain excluded and source diversity is never forced through the
  relevance threshold.
- Subject-aware retrieval excludes books with a clearly conflicting title-level
  domain while retaining relevant and uncategorized sources for normal reranking.
- Semantic candidates are searched in native SQLite vector storage instead of
  parsing and comparing every JSON embedding in JavaScript. The index rebuilds
  automatically when stale and retains the prior portable search as a fallback.
- Teacher Mode buffers its answer until the local grounding review finishes;
  ordinary and Smart modes retain token streaming.
- Knowledge answers can use five bounded, reranked passages instead of three
  shorter raw matches, improving cross-source context without flooding small
  local models.
- Compatible Knowledge Vault files continue ingesting successfully even when
  separate incompatible sources are skipped and reported.
- Ranga's visual treatment was refined into a restrained golden-retriever
  silhouette with pastel theme-aware colouring, subtle cursor attention, sparse
  ambient particles, and a calmer thinking-light treatment.
- The repository and product identity were unified under the Rangabot name.

### Fixed

- Streaming answers no longer force the reader to the bottom after they scroll
  upward, while near-bottom readers still follow new tokens automatically.
- Chat history now persists locally through SQLite and loads safely in Next.js
  development.
- The pin control remains discoverable without requiring a precise hover state.
- Knowledge retrieval no longer mixes unrelated Python, mythology, history, or
  data-science passages merely because filler words overlap.
- Stale pre-rename database paths are relinked by content hash instead of leaving
  books apparently indexed but inaccessible.
- Empty HTML, image-only PDFs, and page-marker-only extractions are rejected
  instead of being advertised as searchable knowledge. `knowledge:doctor`
  reports unindexed, moved, stale, incompatible, and textless sources.
- `knowledge:doctor` distinguishes known incompatible sources from genuinely
  pending files, so skipped files no longer trigger a false re-ingestion action.
- Word creation no longer turns creative requests into generic business reports
  containing purpose, audience, raw chat answers, or planning scaffolding.
- Children's story collections require complete reader-facing stories and use a
  dedicated layout rather than a report template.
- Malformed local-model schema fragments such as `sections`, `heading`, or
  `bullets` are rejected instead of leaking into generated Word documents.
- Markdown markers and duplicated bullet symbols are normalized before DOCX
  rendering.
- Privacy validation no longer removes a running Next.js server's build output.

### Security and privacy

- Vault sources, indexes, chats, memories, generated artifacts, and repository
  approvals remain local and Git-ignored.
- Repository context is read only from explicitly approved folders and is sent
  only to local Ollama.
- Cloud/Codex handoff remains disabled until a separate preview and visible user
  approval flow is designed and approved.
- Continuous learning will be inspectable, editable, deletable, provenance-aware,
  and reversible. Conversations will never modify model weights automatically.

### Planned next

1. Plan questions using the conversation, then retrieve and compare relevant
   material across multiple books and conversation
   history.
2. Synthesize original explanations from vault evidence, local-model knowledge,
   and user context rather than returning retrieved text.
3. Add reviewable local memory for preferences, proficiency, progress,
   corrections, and user-approved conclusions.
4. Add draft, grounding, completeness, and revision passes plus a permanent local
   evaluation suite that proves whether Rangabot is improving.

## 0.1.0 - 2026-07-28

### Added

- A Next.js 16, React 19, and TypeScript application hosted locally on
  `127.0.0.1`.
- A typed Ollama provider abstraction, local status and chat endpoints, streaming
  responses, and Stop generation.
- Local-only, Smart routing, and Teacher Mode controls with visible privacy and
  Knowledge Vault indicators. Cloud/Codex mode remained safely disabled.
- Responsive Apple-inspired chat UI with pastel light and dark themes, Markdown,
  syntax-highlighted code, copy controls, message replies, loading states, and
  the animated Ranga mascot.
- Local SQLite conversation creation, listing, reopening, updating, and deletion.
- Local project folders for organizing project-scoped chat history.
- A private 4 GB Knowledge Vault with incremental PDF, DOCX, HTML, Markdown, and
  text ingestion, hybrid keyword/embedding retrieval, citations, backups,
  validation, rollback, and self-service maintenance commands.
- Automatic Smart-mode vault lookup and Teacher Mode capability/catalog answers.
- Initial offline data-science material for NumPy, pandas, scikit-learn, and
  DuckDB, plus sourced weekly and monthly subject-intelligence briefs.
- Open-source governance, contribution, security, support, architecture, privacy,
  model-selection, source-licensing, and community-launch documentation.
- A public local-model registry with hardware and upstream-license guidance.
- Linux and Windows CI, macOS clean-clone rehearsal, secret scanning, privacy
  checks, and protected pull-request development.
- Apache-2.0 licensing for code and documentation, CC BY 4.0 licensing for
  original Ranga artwork, provenance records, and a distinct-product naming
  policy for modified distributions.
- A synthetic public demo and privacy-safe screenshots.

### Fixed

- Initial chat overflow and scrolling problems.
- SQLite loading failures during Next.js development.
- Repeated welcome content and overly active mascot animation.
- Small or hard-to-find Knowledge Brief and pinning controls.
- Source licensing and release-readiness gaps discovered during the open-source
  rehearsal.

[Unreleased]: https://github.com/saketh-viswanadh/rangabot/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/saketh-viswanadh/rangabot/releases/tag/v0.1.0
