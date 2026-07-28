# Rangabot roadmap

## Approved

- [x] Local Ollama provider behind typed interfaces
- [x] Streaming responses and Stop generation
- [x] Apple-inspired interface and Ranga mascot
- [x] Minimal golden-retriever Ranga with ambient thinking-light treatment
- [x] Pastel light/dark themes and mode-aware restrained Ranga styling
- [x] Local SQLite conversation history: create, list, reopen, update, and delete
- [x] Markdown and syntax-highlighted code rendering with copy controls
- [x] Message hover affordances and reply-to-message context
- [x] Varied offline welcome rotation with quotes, jokes, and original thoughts
- [x] Local project folders with project-scoped chat history
- [x] Private 4 GB Knowledge Vault with incremental local document ingestion
- [x] Hybrid keyword and embedding retrieval with Teacher Mode citations
- [x] Weekly and monthly local knowledge update reporting
- [ ] Model management for installed models and active selection
- [ ] Repository selection with an explicit filesystem allowlist
- [ ] Local code search with scoped file-context previews

## Proposed

- Conversation search and pinning
- Export or import a conversation as a local Markdown file
- Automated local evaluation fixtures for comparing smaller models
- Page-aware source previews and subject-specific retrieval evaluation suites

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
  runtime network request; additions require attribution and duplicate checks.
- Projects currently organize local chats only. Selecting a project never grants
  filesystem access; repository attachment remains a separate allowlist flow.
- Knowledge files and indexes remain private and Git-ignored. Only source
  metadata and update reports are versioned. Rangabot uses retrieval rather than
  changing chat-model weights, making sources inspectable and updates reversible.
