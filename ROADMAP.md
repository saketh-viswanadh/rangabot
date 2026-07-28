# Rangabot roadmap

## Approved

- [x] Open-source governance, security, support and contribution foundation
- [x] Guided/non-interactive setup, doctor and privacy-check commands
- [x] Public local-model registry with hardware and upstream-license guidance
- [x] Self-service Knowledge Vault initialization, validation, backup and rollback
- [x] Pull-request CI and community issue templates
- [ ] Fresh-clone and cross-platform open-source release rehearsal
- [x] Final Ranga artwork and Rangabot branding license decision
- [ ] Historical Git-object secret scan before visibility change
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
- [x] Weekly and monthly sourced subject-intelligence briefs
- [x] Deterministic Teacher Mode answers for current-awareness questions
- [x] Automatic local-vault lookup for relevant Smart-mode questions
- [x] Initial data-science pack: NumPy, pandas, scikit-learn, and DuckDB
- [ ] Model management for installed models and active selection
- [x] Repository selection with an explicit filesystem allowlist
- [x] Local code search with scoped file-context previews
- [x] Explicit code-preview attachment with visible send scope and local-only delivery
- [x] Artifact-skill foundation: ordered registry, shared quality contract and welcome entry points
- [ ] A1: Professional Word document creation and editing
- [ ] A2: Validated PDF reports and summaries
- [ ] A3: Local email drafting and critique (no sending)
- [ ] A4: Long-form writing studio
- [ ] A5: Repository-grounded technical documentation and diagrams
- [ ] A6: Presentation deck generation with visual QA
- [ ] A7: Spreadsheet generation with formula and chart validation

## Proposed

- Automated local evaluation fixtures for comparing smaller models
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
- Knowledge files and indexes remain private and Git-ignored. Only source
  metadata and update reports are versioned. Rangabot uses retrieval rather than
  changing chat-model weights, making sources inspectable and updates reversible.
- Weekly/monthly reports describe external subject developments only. Internal
  ingestion and product work are deliberately excluded. Each item must include
  a date, significance, direct source, evidence class, and local indexing state.
- Smart mode automatically retrieves local evidence for informational questions
  and visibly identifies vault-backed answers. Teacher Mode stays citation-first
  and evidence-bound; Local-only mode never performs vault retrieval.
