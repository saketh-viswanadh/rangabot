# Architecture

Rangabot is a local Next.js application. The browser UI calls server-side API
routes bound to loopback. Those routes use typed provider interfaces to reach a
local Ollama process, SQLite for conversations, and a private hybrid retrieval
index for the Knowledge Vault.

```text
Browser UI on 127.0.0.1
        |
Next.js local API routes
   |         |          |
Ollama    SQLite     Knowledge Vault
chat/embed  chats    FTS5 + embeddings
```

Routing modes:

- **Local only:** downloaded chat model; no vault lookup.
- **Smart:** downloaded model plus automatic local vault retrieval when useful.
- **Teacher:** evidence-bound local retrieval with citations.
- **Codex:** disabled until a visible disclosure and approval flow exists.

Provider, knowledge, routing and persistence logic should remain independent of
the UI. Major changes to these boundaries require an Architecture Decision
Record under `docs/decisions`.
