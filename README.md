# Rangabot

A beautiful, local-first assistant for private chat, coding, brainstorming and
teaching from your own documents. Rangabot uses downloaded Ollama models and a
local Knowledge Vault; cloud handoff remains disabled.

![Rangabot Teacher Mode using synthetic local-vault content](docs/media/rangabot-dark-teacher.png)

## First run

1. Install Node.js 24+ and [Ollama](https://ollama.com/).
2. Run `npm install`.
3. Run `npm run setup` for guided model selection and private vault setup.
4. Run `npm run doctor` to verify the installation.
5. Start with `npm run dev` and open `http://127.0.0.1:3000`.

Experienced users can copy `.env.example` to `.env.local` and use the manual
model guidance in [docs/models.md](docs/models.md).

The server binds only to the local computer by default.

## Current milestone

- Local chat interface
- Local-only / smart-routing / Codex mode controls
- Ollama availability and model detection
- Streaming local Ollama chat responses
- Stop generation control
- Local SQLite conversation history with reopen, search, pin, Markdown backup/restore and delete controls
- Markdown responses, GitHub-style tables, syntax-highlighted code, and copy controls
- Local project folders and project-scoped chats
- Explicit local repository allowlisting with reversible access approval
- On-demand scoped code search with bounded, line-numbered local file previews
- Explicit code-preview attachment to a chat, revalidated at send time for local Ollama only
- Local Word Studio for structured, model-assisted DOCX creation, validation, rendered previews and download
- Private 4 GB Knowledge Vault with PDF, DOCX, HTML, Markdown, and text ingestion
- Hybrid local keyword and embedding retrieval
- Teacher Mode with passage citations and explicit evidence limits
- Automatic local Knowledge Vault lookup for informational questions in Smart mode
- Weekly and monthly sourced subject-intelligence briefs
- Dedicated Knowledge Brief panel with news cards, vault status and app changelog
- Offline welcome library with 100 quotes, 100 jokes and 100 thoughts, plus a 60-item no-repeat window
- No cloud transmission

Conversation data stays in `data/rangabot.db` on this computer. The database and
its journal files are excluded from Git.

Repository approvals stay in the private, Git-ignored
`data/repositories.json` file. Adding a repository records only its canonical
folder path. Selecting an approved repository opens on-demand code search.
Rangabot reads only eligible text/code files after an explicit search, skips
secrets, symlinks, dependencies and build output, and never creates a background
repository index.
An attached preview is visibly listed above the composer before sending. Saved
chats retain only the repository, file and line-range reference; the raw source
preview is read again at send time and supplied only to the local Ollama model.

## Artifact skills

Rangabot now creates new `.docx` files through Word Studio. A structured brief is
drafted by the configured local Ollama model, rendered with deterministic styles,
stored under `data/artifacts/`, validated, and previewed locally when LibreOffice
and Poppler are installed. Existing-file editing and the remaining artifact
abilities are separate backlog items. See [the artifact delivery
plan](docs/ARTIFACT_SKILLS.md) for the ordered backlog and quality contract.

Run `npm run setup` to initialize the private artifact directory and
`npm run doctor` to check whether optional Word page-preview tools are available.
DOCX creation still works when those tools are absent, but Rangabot will show a
visual-review warning instead of claiming that page rendering passed.

## Knowledge Vault

Put documents in `data/knowledge/inbox/` and run:

```bash
npm run knowledge:ingest
```

The importer hashes every file, skips unchanged material, extracts text locally,
splits it into small teaching passages, builds an SQLite FTS5 index, and creates
embeddings through the local Ollama embedding model. PDF extraction includes
page markers. DOCX, HTML, Markdown, and plain-text files are also supported.

Select **Teacher mode** in Rangabot to retrieve relevant vault passages before
the chat model answers. Teacher Mode is instructed to cite the numbered local
sources, identify gaps, and preserve conflicting historical or mythological
interpretations instead of silently inventing an answer.

**Smart routing** also searches the vault automatically for informational and
subject-related questions. Responses visibly show `LOCAL · KNOWLEDGE VAULT`
when retrieval was used. Smart mode may fill evidence gaps from the downloaded
chat model and labels vault citations; Teacher Mode remains the strict option
when answers must stay within indexed sources.

Private source files and generated indexes are Git-ignored. The tracked
`SOURCE_MANIFEST.json` contains only public starter-source metadata; weekly and
monthly reports describe meaningful changes without publishing book content.

Ask **“What’s new in data science this week?”** in Teacher Mode to read the
saved local intelligence brief. These briefs cover meaningful developments in
the subjects themselves—not Rangabot implementation work—and include dates,
why each item matters, evidence type, source links, and indexing status. The
current data-science pack adds official NumPy 2.5, pandas, scikit-learn, and
DuckDB learning/release material. Briefs are indexed too, so they remain
available offline after the weekly source check.

## Next milestones

- Repository selection and local code search
- Page-aware citation display and source preview controls
- Curated technical, history, and mythology source packs
- Retrieval evaluation fixtures by subject
- Model management and active model selection (deferred)
- Cloud handoff preview and approval
- Model registry, evaluation, updates, and rollback
- Safe daily feature-branch automation

## Contributing

Rangabot welcomes community development. Read
[CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), the
[architecture](docs/architecture.md), [privacy model](docs/privacy.md), and
[model guide](docs/models.md). Run `npm run check` before submitting a pull
request. Codex is optional; all required maintenance paths are normal scripts,
documentation and GitHub workflows.

New contributors can browse
[`good first issue`](https://github.com/saketh-viswanadh/rangabot/labels/good%20first%20issue)
and [`help wanted`](https://github.com/saketh-viswanadh/rangabot/labels/help%20wanted)
tasks, or introduce themselves in
[GitHub Discussions](https://github.com/saketh-viswanadh/rangabot/discussions).

CI validates Linux and Windows on every pull request; macOS is covered by the
documented clean-clone release rehearsal. Starter-source licensing and the
local-download-only policy are documented in
[docs/source-licensing.md](docs/source-licensing.md).

Source code and documentation use Apache-2.0. Original Ranga artwork uses CC BY
4.0 with attribution. The Rangabot naming policy is documented in
[BRANDING.md](BRANDING.md).
