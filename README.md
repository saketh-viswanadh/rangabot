# Rangabot

A local-first personal chatbot. Routine coding and brainstorming are processed by a downloaded model through Ollama. Cloud and connected-tool escalation will be added behind explicit previews and approvals.

## First run

1. Install [Ollama](https://ollama.com/).
2. Download the initial model: `ollama pull gpt-oss:20b`.
3. Copy `.env.example` to `.env.local` if you want to change the model or Ollama address.
4. Install dependencies: `npm install`.
5. Start the app: `npm run dev`.
6. Open `http://127.0.0.1:3000`.

The server binds only to the local computer by default.

## Current milestone

- Local chat interface
- Local-only / smart-routing / Codex mode controls
- Ollama availability and model detection
- Streaming local Ollama chat responses
- Stop generation control
- Local SQLite conversation history with reopen and delete controls
- Markdown responses, GitHub-style tables, syntax-highlighted code, and copy controls
- No cloud transmission

Conversation data stays in `data/rangabot.db` on this computer. The database and
its journal files are excluded from Git.

## Next milestones

- Model management and active model selection
- Repository selection and local code search
- Cloud handoff preview and approval
- Model registry, evaluation, updates, and rollback
- Safe daily feature-branch automation
