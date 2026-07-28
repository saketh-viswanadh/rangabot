# ADR 0001: Local-first boundary

- Status: Accepted
- Date: 2026-07-28

Rangabot processes chats and Knowledge Vault content locally by default. Servers
bind to `127.0.0.1`; Ollama is accessed through typed provider interfaces; cloud
handoff remains disabled until an exact-data preview and explicit approval flow
are designed.

This makes privacy behavior inspectable and prevents future integrations from
bypassing the product's central promise. It also means some connected tasks are
unavailable until separately implemented and approved.
