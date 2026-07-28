# Rangabot

A local-first personal chatbot. Routine coding and brainstorming are processed by a downloaded model through Ollama. Cloud and connected-tool escalation will be added behind explicit previews and approvals.

## First run

1. Install [Ollama](https://ollama.com/).
2. Download the lightweight chat model: `ollama pull llama3.2:3b`.
3. Download the local retrieval model: `ollama pull nomic-embed-text`.
4. Copy `.env.example` to `.env.local` if you want to change a model, address,
   or the default 4 GB Knowledge Vault budget.
5. Install dependencies: `npm install`.
6. Add personal documents to `data/knowledge/inbox/`, then run
   `npm run knowledge:ingest`.
7. Start the app: `npm run dev` and open `http://127.0.0.1:3000`.

The server binds only to the local computer by default.

## Current milestone

- Local chat interface
- Local-only / smart-routing / Codex mode controls
- Ollama availability and model detection
- Streaming local Ollama chat responses
- Stop generation control
- Local SQLite conversation history with reopen and delete controls
- Markdown responses, GitHub-style tables, syntax-highlighted code, and copy controls
- Local project folders and project-scoped chats
- Private 4 GB Knowledge Vault with PDF, DOCX, HTML, Markdown, and text ingestion
- Hybrid local keyword and embedding retrieval
- Teacher Mode with passage citations and explicit evidence limits
- Weekly and monthly Knowledge Vault update reports
- No cloud transmission

Conversation data stays in `data/rangabot.db` on this computer. The database and
its journal files are excluded from Git.

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

Private source files and generated indexes are Git-ignored. The tracked
`SOURCE_MANIFEST.json` contains only public starter-source metadata; weekly and
monthly reports describe meaningful changes without publishing book content.

## Next milestones

- Repository selection and local code search
- Page-aware citation display and source preview controls
- Curated technical, history, and mythology source packs
- Retrieval evaluation fixtures by subject
- Model management and active model selection (deferred)
- Cloud handoff preview and approval
- Model registry, evaluation, updates, and rollback
- Safe daily feature-branch automation
