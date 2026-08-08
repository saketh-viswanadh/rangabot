# Rangabot development rules

- Treat `content/rangabot-charter.json` and its generated
  `docs/RANGABOT_CHARTER.md` as the product north star. Every material proposal
  must explain how it improves meaningful local work on ordinary hardware while
  preserving user ownership, honest model limits, and evidence-backed quality.
- Privacy is a product feature. Default to local processing and never add a cloud handoff without a visible disclosure and user approval.
- Bind development and production servers to `127.0.0.1` unless the user explicitly requests network access and authentication is implemented first.
- Keep model providers behind typed interfaces so Ollama can be replaced without rewriting the UI.
- Run `npm run typecheck`, `npm run lint`, and `npm run build` before calling a change complete.
- Do not push directly to `main`. Daily automation should use a dated branch and draft pull request.
