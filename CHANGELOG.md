# Changelog

All notable released changes will be documented here using
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) principles.

## Unreleased

### Added

- Word Studio for creating new professional `.docx` files from a structured
  brief using local Ollama drafting, deterministic formatting, private storage,
  format checks, rendered page previews and a visible quality report.
- An ordered local artifact-skill registry, shared quality-gate contract and
  fresh-chat entry points for email and document work. Word export is the next
  ability and is not presented as complete yet.
- Explicit local code attachment from a bounded preview, with a visible composer
  disclosure and saved file/line reference while raw source stays out of history.
- On-demand local code search and bounded line-numbered previews restricted to
  explicitly approved repository folders.
- An explicit local repository allowlist with canonical-path validation and
  revocation that never modifies the selected folder.
- Local Markdown conversation export and restore, including exact recovery of
  message roles, code blocks and reply references.
- Local conversation search across titles and message content, scoped to the
  selected project when applicable.
- Persistent conversation pinning with pinned chats sorted above recent chats.
- A dedicated Knowledge Brief drawer with weekly intelligence cards, monthly
  archive, private-vault status and a separate Rangabot product changelog.
- A bundled 300-item welcome library with 100 quotes, 100 jokes and 100 thoughts.
- A browser-local 60-item recent-history window to prevent welcome messages from
  repeating across new chats and page reloads.

### Fixed

- Unpinned conversation controls remain subtly visible instead of only appearing
  during hover, making the pin action discoverable.
- Streaming responses no longer force the reader to the bottom after they
  intentionally scroll upward.

## 0.1.0 - 2026-07-28

### Added

- Responsive local-first chat with light and dark pastel themes, project folders,
  message replies, Markdown, syntax highlighting and copy controls.
- Streaming Ollama responses, stop generation and local SQLite conversation
  history.
- Local-only, Smart routing and Teacher Mode controls with visible privacy and
  retrieval labels.
- A private Knowledge Vault with local PDF, DOCX, HTML, Markdown and text
  ingestion, hybrid retrieval, citations and weekly/monthly intelligence briefs.
- Animated Ranga mascot, synthetic launch demo and privacy-safe screenshots.
- Open-source setup, diagnostics, privacy validation and community documentation.
- Local model registry and self-service Knowledge Vault commands.
- Final CC BY 4.0 licensing and provenance records for original Ranga artwork,
  plus a distinct-product naming policy for modified distributions.
- Linux and Windows CI with required checks on protected `main`.

### Fixed

- Validation cleanup now removes only stale duplicate generated type files and
  never deletes a live development server's `.next` runtime output.

[Unreleased]: https://github.com/saketh-viswanadh/rangabot/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/saketh-viswanadh/rangabot/releases/tag/v0.1.0
