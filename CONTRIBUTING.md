# Contributing to Rangabot

Thank you for helping build a private, local-first assistant. Contributions are
welcome across models, retrieval, UI, accessibility, documentation, testing and
platform support.

## Start locally

1. Fork and clone the repository.
2. Install Node.js 24+ and [Ollama](https://ollama.com/).
3. Run `npm install` and `npm run setup`.
4. Run `npm run doctor`, then `npm run dev`.

Never use real chats or personal documents as test fixtures. Put private files
only in `data/knowledge/inbox`; that directory is intentionally Git-ignored.

## Pull requests

- Create a short-lived branch from `main`.
- Keep one coherent capability or fix per pull request.
- Add tests for behavior changes.
- Run `npm run check` and `npm audit --omit=dev`.
- Explain privacy, model, storage and network implications.
- Do not add cloud transmission or non-loopback binding without a visible user
  approval design and prior maintainer discussion.

Contributions are licensed under Apache-2.0. Third-party source material and
models retain their own licenses and must be documented separately.
