# Privacy model

Rangabot defaults to local processing, but local software is not automatically
private in every environment. Users remain responsible for operating-system
accounts, disk encryption, backups, browser extensions and other processes that
can access local files.

The application guarantees by design:

- loopback-only server binding by default;
- explicit loopback Host validation plus purpose-separated signed bootstrap and
  browser-session capabilities; only the fragment-bound startup URL can mint a
  session, and the fragment is removed before redirecting to the clean app URL;
- strict same-origin checks, JSON-only bounded mutations and non-cacheable APIs;
- loopback-only Ollama chat and embedding configuration enforcement;
- no enabled cloud chat handoff;
- Git-ignored chats, documents, indexes and embeddings;
- owner-only managed database, vault and artifact permissions on POSIX systems;
- owner-only atomic evaluation output and Knowledge backup storage;
- remote model-authored images and unapproved browser network resources blocked;
- repository approvals bound to a canonical filesystem identity and revalidated
  before bounded, no-symlink reads;
- one process-local active app-chat generation per resolved model, four queued
  requests and server-owned cancellation (Knowledge ingestion embeddings are a
  separate CLI path);
- bounded buffered and streamed model output with typed resource-limit failure;
- dataset approval bound to filesystem identity and SHA-256, with DuckDB using
  a private immutable snapshot of the exact validated bytes;
- bounded SQL worker heap, schema, column, cell and total-result transfer;
- crash-recoverable artifact deletion and validated Knowledge index restore guarded
  by a cross-process runtime lease;
- visible routing modes;
- no silent model downloads;
- bounded chat request history and high-confidence repository secret filtering;
- explicit source metadata for public starter knowledge.

These controls protect against accidental exposure, hostile webpages, CSRF,
DNS rebinding, symlink retargeting, mutable approved-dataset paths, and unbounded
local-model concurrency or output. They do
not protect against same-user malware, administrators, unencrypted physical
access, operating-system/cloud backups, or storage-device remanence. SQLite
secure deletion does not erase old backups or snapshots. See
[the security policy](../SECURITY.md) for the full boundary and repair command.

Contributions that add telemetry, remote APIs, network binding, account systems
or cloud handoff require prior design discussion, a visible disclosure of exact
data leaving the device, and explicit user approval.
