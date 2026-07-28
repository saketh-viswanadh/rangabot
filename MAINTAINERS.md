# Maintainer guide

Codex is not required to maintain Rangabot. Normal project operations are:

- `npm run doctor` — diagnose a local installation.
- `npm run check` — run tests, lint, type checking, build and privacy checks.
- `npm run knowledge:status` — inspect local vault size and indexing state.
- `npm run knowledge:ingest` — incrementally index changed private documents.
- `npm audit --omit=dev` — check production dependency advisories.

Use GitHub Issues and milestones for planning, pull requests for review, and
`CHANGELOG.md` for released behavior. Significant privacy, provider, routing or
storage decisions should be recorded under `docs/decisions` before implementation.

Weekly subject intelligence is human-reviewed. Verify dates and claims against
primary sources, label preprints and reported benchmarks, and do not include a
development changelog in the user-facing knowledge briefs.
