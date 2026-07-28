# Rangabot roadmap

## Approved

- [x] Local Ollama provider behind typed interfaces
- [x] Streaming responses and Stop generation
- [x] Apple-inspired interface and Ranga mascot
- [x] Local SQLite conversation history: create, list, reopen, update, and delete
- [x] Markdown and syntax-highlighted code rendering with copy controls
- [ ] Model management for installed models and active selection
- [ ] Repository selection with an explicit filesystem allowlist
- [ ] Local code search with scoped file-context previews

## Proposed

- Conversation search and pinning
- Export or import a conversation as a local Markdown file
- Automated local evaluation fixtures for comparing smaller models

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
