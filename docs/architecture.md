# Architecture

The shared conversation control plane is specified in
[Mind & Memory release architecture](MIND_MEMORY_ARCHITECTURE.md). Every product
mode reuses its precedence, memory, capability and provider boundaries.

Rangabot is a loopback-only Next.js application. Its launcher prints a signed,
one-process bootstrap URL; the browser exchanges that fragment-bound capability
for a signed same-origin session before any private API can be read. The proxy
enforces loopback Host, Origin/Fetch Metadata, request size/type and no-store
responses. Remote browser resources and remote Ollama endpoints are disabled.

```text
Printed one-launch capability
           |
Browser on 127.0.0.1 -- signed session --> Next.js proxy + local API
                                              |
                +-----------------------------+-------------------------+
                |                             |                         |
        Durable turn ledger          Permissioned local data      Knowledge Vault
        + generation gate             repository identity          FTS5 + embeddings
                |                     dataset identity + hash              |
        bounded local Ollama                  |                     cited retrieval
        chat stream + Stop             immutable snapshot
                                              |
                                      bounded DuckDB worker
```

Private app state uses owner-only managed storage on POSIX:

- SQLite stores for conversations, memories and the generated Knowledge index;
- explicit repository/dataset allowlists bound to filesystem identity;
- owner-only evaluator/checkpoint output;
- generated Word artifacts with reference-aware deletion quarantine;
- checksummed Knowledge index database backups and a shared runtime/restore
  lease.

The server-owned turn ledger snapshots bounded context, records one pending turn
per conversation, commits completed history atomically and keeps failed or
cancelled partials inspectable without reusing them as future prompt context.
App chat generations share a process-local one-active/four-queued gate per model;
Stop reaches the server-owned `AbortController`, and provider bodies/streams are
size- and time-bounded.

Routing modes:

- **Local only:** downloaded chat model; no vault lookup.
- **Smart:** downloaded model plus automatic local vault retrieval when useful.
- **Teacher:** evidence-bound local retrieval with citations.
- **Codex:** disabled until a visible disclosure and approval flow exists.

The analytics path never gives the model direct filesystem or SQL execution.
The model-independent planner receives only an approved dataset descriptor;
Rangabot snapshots the exact approved bytes, executes read-only SQL in a
resource-bounded worker, and renders verified facts plus an inspectable receipt.

Provider, knowledge, routing, persistence, permission and lifecycle logic remain
independent of the UI. Major changes to these boundaries require an Architecture
Decision Record under `docs/decisions` and new adversarial tests.
