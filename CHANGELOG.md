# Changelog

All notable Rangabot changes are documented here using
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) principles. This file
records the complete product journey; `DAILY_PROGRESS.md` contains implementation
notes and `ROADMAP.md` separates approved, proposed, and decision-dependent work.

## Unreleased

### Added

- Path to Mastery v2 now audits 9 program epics, 45 capabilities, and 146
  criterion assessments with calculated scores/states and a canonical registry
  of 41 merged PRs used as evidence. It adds the omitted Platform & Release epic
  and displays criterion notes and evidence links in the app and public chart.
- Founder recognition was re-audited into 29 attributable node claims.
  Contribution credit is explicitly independent from product readiness and
  cannot be attached to a wholly planned capability.

- A privacy-safe public product showcase now presents the current conversation
  workspace, local Knowledge Brief, and Path to Mastery beneath the repository
  banner instead of using brand art as the only visual evidence of Rangabot.

- Frozen Core Conversation Contract v1 and a balanced 60-case synthetic suite
  replace the earlier 20-case exploratory check. Results now record suite,
  commit, model, Ollama, context, hardware, run-state, completion, critical-trust,
  per-capability, latency, and error provenance. A public evaluator changelog
  records every rubric repair and its effect on comparability.

- Centralized runtime product identity, registry-derived default models, stricter
  unused-code checks, runtime-only filesystem tracing, and generated Next type
  handling reduce duplicated configuration and build noise.
- Repository maintenance now automatically deletes future merged branches; ten
  already-merged remote branches and two completed issues were reconciled.
- A model-independent conversation orchestration layer now gives every local
  model the same directness, truthfulness, recency, correction, hard-constraint,
  and memory-precedence contract before ordinary chat generation.
- A private synthetic Mind & Memory stress suite measures instruction following,
  continuity, reasoning, honest capability boundaries, adaptation, memory use,
  memory privacy, and latency without reading real conversations or memories.
- A chat-focused sidebar keeps projects, search, transfers, and conversation
  history together while moving Brief, Memory, Mastery, local folders, and the
  privacy indicator into a compact responsive header utility rail.
- A title-first conversation focus stack expands the hovered chat, reveals its
  actions on demand, and gently recedes neighboring titles; All chats and folder
  marks now use lighter layered linework.
- Inspectable local memory for explicitly approved preferences, facts, and
  standing instructions, with visible provenance, edit/delete controls, JSON
  export, and bounded context injection into ordinary and Teacher Mode chats.
- Deterministic direct-memory recall for identity and memory-list questions so
  small local models cannot ignore a saved fact or improvise an answer.
- Persistent per-answer memory receipts distinguish ordinary approved-context
  use from deterministic direct recall in both live and reopened conversations.
- Review-first Local memory JSON import with strict provenance and size checks,
  duplicate skipping, conservative conflict detection, and explicit per-conflict
  replacement approval.
- Relevance-aware Local memory selection prevents unrelated approved facts from
  entering a model request and discloses only safe memory titles on each answer.
- Governed, evidence-backed mastery attribution with CODEOWNER protection, a
  public claim workflow, local-only optional portraits, node-level contributor
  credits, and founder recognition covering 19 verified capabilities.
- A shared Japanese-craft-inspired SVG icon language across navigation, chat,
  creation tools, local privacy controls, Knowledge Brief and Path to Mastery,
  replacing platform-dependent Unicode symbols with restrained local geometry.
- **Path to Mastery**, an interactive Assassin-inspired capability tree whose
  main paths, subskills, strict scores, dependencies, acceptance criteria and
  next tasks also form Rangabot's public contributor backlog.
- A canonical mastery JSON model and generated Markdown view, including an
  approved persistent web-allowlist node that must unlock before web research.
- A spacious, scrollable mastery layout with Rangabot banner art, hover and
  keyboard unlock previews, complete public checklists, and an opt-in local
  contributor achievement wall that never fetches GitHub avatars at runtime.
- Conversation-aware local retrieval planning for context-dependent follow-up
  questions, using the latest substantive user topic without changing the
  question Rangabot answers.
- Per-answer retrieval diagnostics distinguish full hybrid search from the safe
  keyword-only fallback in the chat source label and persisted history.
- A registered story-pack interface replaces route-level Ramayana branching and
  provides one bounded extension point for future provenance-aware collections.
- A contradiction regression rejects answers that collapse data leakage and
  concept drift into the same concept.
- A severity-ranked full-tree code, privacy, dependency, documentation, and
  public-GitHub review with explicit unresolved risks.
- Shared bounded chat validation and local-runtime configuration tests.
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
- A balanced 60-question benchmark spanning ten subject groups and three
  difficulty levels, with answer-level concept, grounding, forbidden-claim,
  cited-source synthesis, revision, and latency scoring.
- Resumable answer evaluation with per-case atomic checkpoints, a five-minute
  evaluation timeout, isolated error reporting, and automatic retry of only
  unfinished cases.
- A Teacher Mode grounding gate that audits citation coverage, citation numbers,
  and lexical support before returning an answer, revises weak drafts once
  locally, and warns visibly when the revision remains insufficiently grounded.

### Changed

- Removed unused mascot GIF/sprite-atlas and stale screenshot payloads while
  retaining the PNG and CSS motion used by the live interface.
- Deferred the Memory panel and 301 KB Markdown/highlighting implementation until
  first use, reducing the main application-specific client chunk from roughly
  362 KB to 57 KB in the audited production build.
- Updated React type definitions to current compatible patch releases.

- Knowledge Doctor now streams large-file hashing, reports when its deep scan
  starts, and returns a clear incomplete-check warning after a bounded timeout.
- Ollama chat and embedding configuration is now centrally validated as
  loopback-only, with the documented lightweight model as the single fallback.
- Answer evaluations exclude execution errors from completed-case quality and
  latency averages and report a separate conservative overall pass floor.
- Repository previews now reject high-confidence secret content in addition to
  common sensitive filenames; document preview rendering no longer overrides
  the subprocess home directory.
- Updated `pdfjs-dist` to 6.2.108 and added defensive response headers.
- Teacher Mode now maps each requested answer part to the strongest matching
  passages before drafting. When a first draft fails the unchanged grounding
  gate, Rangabot tries fast deterministic evidence/background separation before
  spending time on a second local-model generation; revision remains available
  only when that safe local transformation is insufficient.
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
- Subject recognition now covers implicit SQL/statistics questions and compact
  or domain-specific source titles, raising the 60-question retrieval pass rate
  from 85% to 90% while eliminating measured cross-subject contamination.
- Semantic candidates are searched in native SQLite vector storage instead of
  parsing and comparing every JSON embedding in JavaScript. The index rebuilds
  automatically when stale and retains the prior portable search as a fallback.
- Teacher Mode buffers its answer until the local grounding review finishes;
  ordinary and Smart modes retain token streaming.
- Teacher Mode now normalizes small-model `[N]` citations, keeps nested content
  inside an explicit Local model background boundary, ignores adjacent but
  unhelpful passages, and answers the actual question before adding detail.
- Teacher Mode now receives an explicit subtopic and claim-to-source plan before
  drafting, retains the better-grounded version when revision regresses, joins
  isolated citation markers to their claims, and conservatively recovers missing
  citations only when one passage has strong lexical support.
- Answers that remain mixed after revision are deterministically separated into
  vault-grounded evidence and clearly disclosed local-model background instead
  of returning an undifferentiated warning-laden draft.
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
