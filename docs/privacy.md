# Privacy model

Rangabot defaults to local processing, but local software is not automatically
private in every environment. Users remain responsible for operating-system
accounts, disk encryption, backups, browser extensions and other processes that
can access local files.

The application guarantees by design:

- loopback-only server binding by default;
- no enabled cloud chat handoff;
- Git-ignored chats, documents, indexes and embeddings;
- visible routing modes;
- no silent model downloads;
- explicit source metadata for public starter knowledge.

Contributions that add telemetry, remote APIs, network binding, account systems
or cloud handoff require prior design discussion, a visible disclosure of exact
data leaving the device, and explicit user approval.
