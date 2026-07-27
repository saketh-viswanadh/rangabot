# Local Codex Assistant development rules

- Privacy is a product feature. Default to local processing and never add a cloud handoff without a visible disclosure and user approval.
- Bind development and production servers to `127.0.0.1` unless the user explicitly requests network access and authentication is implemented first.
- Keep model providers behind typed interfaces so Ollama can be replaced without rewriting the UI.
- Run `npm run typecheck`, `npm run lint`, and `npm run build` before calling a change complete.
- Do not push directly to `main`. Daily automation should use a dated branch and draft pull request.
