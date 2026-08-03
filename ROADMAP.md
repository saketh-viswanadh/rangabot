# Rangabot roadmap

## Current execution order

From 2026-08-02 through 2026-08-08, the broader order below is frozen. The only
active product priority is the versioned Core Conversation Reliability plan in
[`docs/CORE_CONVERSATION_CONTRACT.md`](docs/CORE_CONVERSATION_CONTRACT.md).

The completed foundation remains documented below. New work follows this order
unless user feedback exposes a more urgent defect:

1. **Learning Core foundation** — hierarchical ingestion plus source-aware,
   multi-book retrieval.
2. **Knowledge synthesis** — conversation-aware planning, comparison across
   sources, disagreement handling, and original explanations that combine cited
   vault evidence with clearly labelled downloaded-model background.
3. **Inspectable local learning** — preferences, proficiency, progress,
   corrections, and approved conclusions with provenance and user controls.
4. **Quality engine** — draft, grounding review, revision, feedback capture, and
   regression evaluation across teaching, coding, research, and writing.
5. **Cross-book knowledge layer** — rebuildable concept summaries and
   relationships that update when the vault changes.
6. **Artifact expansion** — existing Word editing, then PDF, email drafting,
   long-form writing, technical documentation and diagrams, presentations, and
   spreadsheets, each using the shared gold-standard validation contract.
7. **Deferred platform work** — installed-model management, optional local
   encryption, and any cloud/Codex handoff design.

Automatic model-weight mutation is not part of this sequence. A reviewed
fine-tuning dataset and rollback workflow remain a later proposal.

## Approved

- [x] Establish a versioned, balanced 60-case synthetic Mind & Memory benchmark and a shared
  model-independent conversation contract for directness, truthfulness,
  correction precedence, bounded history, and selective local memory
- [x] Establish the Mind & Memory control-plane architecture with shared mode
  precedence, compiled answer contracts, conflict-aware memory, typed provider
  failures, Stop propagation, and narrow conformance repair
- [ ] Complete the remaining frozen v1.0.11 release gates. The verified-ledger
  candidate reached 59/60 overall, 22/22 critical, 5/5 reasoning, and 5.9-second
  mean latency with every category at least 4/5. Repeat all critical cases for
  this exact candidate and complete blinded human usefulness review.
- [ ] Add deterministic provider simulations for missing models, partial and
  malformed streams, empty output, cancellation, timeout, and persistence
  integrity before declaring runtime mastery
- [x] Establish a bounded read-only DuckDB execution kernel with approved-file
  validation, external-access shutdown, resource caps, and receipts
- [x] Add persistent local dataset approvals plus an exact-query, expiring,
  single-use SQL preview and execution confirmation protocol
- [x] Add an app-visible SQL proposal card with dataset, query, limits,
  approve/reject controls, results, and execution receipt; never auto-execute
- [x] Let an explicitly attached approved dataset contribute schema-only context
  to local chat so the model can draft validated SQL into the review workspace
- [x] Make approved local data conversational: detect analytical intent, execute
  bounded read-only SQL, audit numeric narration, and retain an inspectable trace
- [x] Add native read-only multi-table DuckDB inspection plus a frozen 50-case
  benchmark covering four difficulty and four context levels
- [x] Replace free-form SQL for simple aggregates with a constrained analytical
  plan and deterministic compiler; unchanged-suite evidence improved from 3/50
  to 12/50 and the easy tier reached 9/10
- [ ] Extend the analytical compiler to derived metrics, multiple measures,
  intervals, grouped subqueries and medium-tier calculations. Current medium
  score is 2/15; no broad autonomous multi-table reliability claim is permitted
- [ ] Enforce provider wall-clock timeout independently of a stalled Ollama
  request; the compiler candidate recorded one 1,544.1-second timeout outlier
- [ ] Add the same policy contract for sandboxed Python statistics, modelling,
  and visualisation; do not permit network, package installation, or file writes
- [ ] Offer verified analytical findings as provenance-bound memory candidates;
  persist only after explicit user approval and invalidate when input data changes
- [x] Add a frozen adaptive-reviewer qualification gate that requires correction
  of every bad draft and preservation of every good draft before activation
- [ ] Qualify a separate approved local reviewer model at 12/12; the installed
  `llama3.2:3b` is blocked after scoring 1/12 and cannot rewrite live answers
- [ ] Expand Mind & Memory evaluation across every supported model profile and
  publish comparable local scorecards without committing private outputs
- [ ] Add inspectable correction and memory-conflict workflows so outdated facts
  can be superseded without silently deleting provenance
- [x] Govern official mastery attribution through evidence-backed claims,
  CODEOWNER approval and node-level contributor recognition.

- [x] Path to Mastery v2: 9 program epics, criterion-level merged evidence,
  calculated readiness, interactive audit details, and governed attribution
- [ ] Close the failed and partial criteria exposed by the v2 audit; readiness
  changes only when the exact listed criterion gains new evidence
- [ ] Persistent local web-domain allowlist with editable capability scopes,
  query previews and immediate revocation
- [ ] Permissioned web research that runs only after local knowledge is
  insufficient and only against approved domains and queries
- [x] Open-source governance, security, support and contribution foundation
- [x] Guided/non-interactive setup, doctor and privacy-check commands
- [x] Public local-model registry with hardware and upstream-license guidance
- [x] Self-service Knowledge Vault initialization, validation, backup and rollback
- [x] Bounded Knowledge Doctor deep scans with streamed hashing, visible progress,
  and a configurable timeout for large private vaults
- [x] Pull-request CI and community issue templates
- [x] Fresh-clone and cross-platform open-source release rehearsal
- [x] Final Ranga artwork and Rangabot branding license decision
- [x] Historical Git-object secret scan before visibility change
- [x] Local Ollama provider behind typed interfaces
- [x] Streaming responses and Stop generation
- [x] Apple-inspired interface and Ranga mascot
- [x] Minimal golden-retriever Ranga with ambient thinking-light treatment
- [x] Pastel light/dark themes and mode-aware restrained Ranga styling
- [x] Local SQLite conversation history: create, list, reopen, update, and delete
- [x] Project-aware local conversation search and persistent pinning
- [x] Local Markdown conversation export and restore
- [x] Markdown and syntax-highlighted code rendering with copy controls
- [x] Message hover affordances and reply-to-message context
- [x] Offline welcome library with 100 quotes, 100 jokes and 100 thoughts, a 60-item no-repeat window, and weekly quality review
- [x] Local project folders with project-scoped chat history
- [x] Private 4 GB Knowledge Vault with incremental local document ingestion
- [x] Hybrid keyword and embedding retrieval with Teacher Mode citations
- [x] Visible per-answer hybrid versus keyword-only retrieval diagnostics
- [x] Portable hash-based vault synchronization, extraction-quality gates, scanned-PDF detection, query cleanup, title-aware hybrid reranking, and cross-subject retrieval tests
- [x] Weekly and monthly sourced subject-intelligence briefs
- [x] Deterministic Teacher Mode answers for current-awareness questions
- [x] Automatic local-vault lookup for relevant Smart-mode questions
- [x] Initial data-science pack: NumPy, pandas, scikit-learn, and DuckDB
- [x] Learning Core 1: Hierarchical ingestion that preserves book, chapter,
  section, heading, page, and passage relationships
- [ ] Learning Core 2: Conversation-aware query planning and multi-source
  retrieval across books, local-model knowledge, and relevant chat history
- [x] Learning Core 2d: Context-dependent follow-up retrieval carries the latest
  substantive user topic into the local search query without rewriting the
  question presented to the model
- [x] Learning Core 2a: Relevance-gated source diversity prevents one matching
  book from monopolizing the evidence window when other strong books contribute
- [x] Learning Core 2b: Subject-aware filtering blocks clearly cross-domain books
  before the final multi-book evidence window is assembled
- [x] Learning Core 2c: Compact native local vector search with automatic
  rebuild, mutation invalidation, and a portable JavaScript fallback
- [ ] Learning Core 3: Evidence synthesis that compares, connects, deduplicates,
  and preserves disagreements before composing an original explanation
- [x] Learning Core 4a: Explicit inspectable local memory for user-approved
  preferences, facts, and instructions with origin, confidence, edit, export,
  delete, bounded chat context, and persistent per-answer usage receipts
- [x] Learning Core 4b: Reviewed Local memory JSON import with duplicate detection,
  conservative conflicts, and explicit keep-or-replace approval
- [x] Learning Core 4c: Deterministic relevance selection with bounded prompt
  context, title-only disclosure, domain scoping, current-choice conflict
  exclusion, newest-wins supersession, and a CI-enforced precision/recall audit
- [ ] Learning Core 4d: Explainable proficiency, corrections, and learning progress
- [ ] Learning Core 5: Draft, grounding review, and revision with visible separation
  between vault evidence, local-model background, and unresolved uncertainty
- [x] Learning Core 5a: Teacher Mode citation audit, one bounded local revision,
  and a visible warning when grounding remains below the quality threshold
- [x] Learning Core 5b: Pre-draft evidence plan, best-draft preservation,
  isolated-citation repair, conservative citation recovery, and deterministic
  vault-evidence versus local-background separation
- [x] Learning Core 5c: Coverage-aware evidence mapping and selective escalation
  that attempts deterministic separation before a second model generation while
  preserving the existing grounding gate
- [ ] Learning Core 6: Feedback capture and regression evaluation proving that
  changes improve synthesis, teaching quality, citations, and completeness
- [ ] Learning Core 6c: Add terminology-contradiction and concept-distinction
  regression checks, beginning with data leakage versus concept drift, without
  weakening or replacing the existing 60-case criteria
- [x] Learning Core 6a: Local retrieval evaluation baseline covering expected
  sources, contamination, diversity, passage locators, and latency
- [x] Learning Core 6b: Balanced 60-question retrieval and complete-answer
  benchmark with per-subject, difficulty, grounding, concept, synthesis, and
  latency measurements
- [ ] Learning Core 7: Rebuildable cross-book concept summaries and relationships
  that update incrementally when compatible sources are added or removed
- [ ] Model management for installed models and active selection
- [x] Repository selection with an explicit filesystem allowlist
- [x] Local code search with scoped file-context previews
- [x] Explicit code-preview attachment with visible send scope and local-only delivery
- [x] Artifact-skill foundation: ordered registry, shared quality contract and welcome entry points
- [x] A1: Conversational Word creation with requirement gathering, validation and rendered previews
- [x] A1 quality hardening: genre-aware story documents, no planning-note fallback, content-depth gates, and a registered curated Ramayana story pack for reliable small-model output
- [x] Concept-distinction regression coverage for known technical conflations,
  beginning with data leakage versus concept drift
- [ ] A1b: Safe editing of user-selected existing Word documents
- [ ] A2: Validated PDF reports and summaries
- [ ] A3: Local email drafting and critique (no sending)
- [ ] A4: Long-form writing studio
- [ ] A5: Repository-grounded technical documentation and diagrams
- [ ] A6: Presentation deck generation with visual QA
- [ ] A7: Spreadsheet generation with formula and chart validation

## Proposed

- Automated local evaluation fixtures for comparing smaller models
- Optional reviewed fine-tuning dataset export after the Learning Core is mature;
  conversations must never modify model weights automatically
- Page-aware source previews and subject-specific retrieval evaluation suites
- Expand the data-science pack with statistics, visualization, experimentation,
  feature engineering, and responsible evaluation material under clear licenses
- Add research-triage lanes for peer-reviewed work, preprints, efficient models,
  and history/archaeology discoveries without mixing evidence levels

## Needs user decision

- What information a future cloud/Codex handoff preview may include. Actual
  sending remains disabled until a separate explicit approval.
- Whether conversation history should support optional local encryption.

## Architecture and decisions

- Next.js 16, React 19, and TypeScript provide the local UI and API routes.
- Ollama is accessed only through the typed provider layer.
- The app and Ollama endpoints default to loopback addresses.
- Conversation history uses Node's built-in SQLite API and is stored under
  `data/`, which is excluded from Git.
- Cloud modes remain visible but disabled; no chat or repository content leaves
  the computer.
- Daily work uses dated branches and draft pull requests. Automation never
  pushes directly to `main` or merges automatically.
- Assistant Markdown is rendered locally; raw HTML is not enabled. External
  links open separately, and code highlighting and copying stay in-browser.
- Appearance preferences stay in browser-local storage. Reply references remain
  in the local conversation record and are expanded only for the local model.
- Welcome content is reviewed and bundled with the app. It never introduces a
  runtime network request. The dated library is reviewed weekly, changed only
  when quality improves, and guarded by count, length, attribution and duplicate tests.
- Projects currently organize local chats only. Selecting a project never grants
  filesystem access; repository attachment remains a separate allowlist flow.
- Repository approvals are canonical absolute paths stored in a private local
  registry. Revocation removes only the approval and never changes user files.
- Repository search is explicit and on demand. It skips sensitive, generated,
  binary, large and symlinked paths; previews are bounded and revalidated under
  the approved canonical root before every read.
- Code attachments save only a visible repository/file/line reference in chat
  history. The server revalidates the approval and bounded preview at send time,
  strips metadata before provider delivery, and sends source only to local Ollama.
- Artifact abilities ship one at a time as complete vertical slices. Every skill
  shares structured-brief, content, deterministic-render, format, visual-review
  and user-preview gates; model output cannot bypass these validations.
- Generated artifacts and temporary renders stay under the Git-ignored
  `data/artifacts/` directory. External sending or publishing is not implied.
- Word creation happens inside ordinary chat. A persisted local intent marker lets
  Rangabot ask follow-up questions across turns; when requirements are sufficient,
  the local model returns a bounded plan and deterministic code constructs,
  validates and renders the file. User review remains mandatory.
- Creative Word requests are classified by genre and must contain finished reader-facing
  content. Story collections cannot fall back to business-report scaffolding. For the
  initial Ramayana use case, a curated local story pack protects canonical episode facts
  from small-model hallucinations while the model still gathers the brief conversationally.
- Knowledge files and indexes remain private and Git-ignored. Only source
  metadata and update reports are versioned. Rangabot uses retrieval rather than
  changing chat-model weights, making sources inspectable and updates reversible.
- Hierarchical ingestion uses a backward-compatible SQLite migration and a
  versioned ingestion format. Existing compatible sources re-index locally once;
  headings and PDF page ranges become searchable metadata without modifying the
  original books.
- Rangabot's Learning Core will treat retrieval as evidence gathering rather than
  the final product. Answers must synthesize relevant vault material, downloaded-
  model background, and conversation context into a fresh explanation suited to
  the user's intent and level.
- Persistent learning must remain local, inspectable, editable, deletable, and
  provenance-aware. User statements are classified as preferences, personal
  context, progress, corrections, or candidate knowledge; they are never silently
  promoted to universal facts.
- Continuous improvement means measured improvement: feedback creates reviewable
  signals and regression cases, while automatic self-training and unreviewed
  model-weight changes remain out of scope.
- Weekly/monthly reports describe external subject developments only. Internal
  ingestion and product work are deliberately excluded. Each item must include
  a date, significance, direct source, evidence class, and local indexing state.
- Smart mode automatically retrieves local evidence for informational questions
  and visibly identifies vault-backed answers. Teacher Mode stays citation-first,
  separating vault evidence from downloaded-model background; Local-only mode
  never performs vault retrieval.
