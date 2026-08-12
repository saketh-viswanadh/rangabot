# Desktop data-root import design

Status: design only. This increment does not copy, move, delete, merge, or
backfill any existing Rangabot data.

## Runtime boundary

Rangabot has two explicit runtime roots:

- `RANGABOT_RESOURCE_ROOT` is the immutable shipped application tree. Package
  metadata, the isolated SQL worker, bundled content, and other read-only
  resources resolve here.
- `RANGABOT_DATA_ROOT` is the owner-private mutable tree supplied by the
  desktop shell from Electron's `app.getPath("userData")` area. Conversations
  (including response feedback), memories, Knowledge Vault state, dataset and
  repository approvals, SQL confirmations, artifacts, and the runtime lease
  resolve here.

The variables must be supplied together as separate, existing, absolute real
directories. Traversal, symbolic-link components, and overlapping configured
roots fail closed. With neither variable set, CLI compatibility remains
explicit: resources use the launch working directory and data uses its existing
`./data` child.

Selecting a new data root is not consent to inspect or import an old one. The
desktop app starts with the state already present in its own data root, which is
normally empty on first launch.

## Future explicit import flow

An importer should be a separate, user-started action labelled **Import existing
local Rangabot data**. It must show the source and destination before reading
private records, require Rangabot to hold an exclusive maintenance lease, and
offer a dry-run inventory containing file categories, byte counts, and conflicts
without conversation or memory content.

The source is opened read-only. Every accepted entry must be an allowlisted
regular file or real directory below the chosen source root; symbolic links,
hard-linked surprises, devices, sockets, traversal, oversized files, and schema
failures are rejected. The importer copies into an owner-only staging directory
inside `RANGABOT_DATA_ROOT`, fsyncs it, records SHA-256 digests, and validates
SQLite integrity and application schemas before activation. It never writes to
or deletes the source.

Import categories should be independently selectable:

- `rangabot.db` plus a consistent SQLite snapshot contains conversations,
  turns, and response feedback.
- `rangabot-memory.db` contains user-approved memories.
- `knowledge/` contains private inbox files, indexes, processed state, and
  backups. Shipped briefs, manifests, and evaluation fixtures remain resources
  and are never imported into the mutable tree.
- `artifacts/` contains locally generated outputs. Interrupted deletion
  quarantine must pass the existing recovery rules before activation.
- Dataset and repository registries may be copied only as untrusted candidates;
  external files and folders must be re-approved against their current identity
  before use.
- Expired SQL confirmations and runtime lease files are never imported.

If destination state exists, the default is **do not merge**. The user may keep
the destination, choose a supported category-level import, or cancel. SQLite
files must use SQLite's backup mechanism or a verified stopped-source snapshot;
copying a live database while ignoring WAL state is prohibited.

## Reversibility and recovery

Before activation, the importer creates a digest-addressed backup of every
destination entry it would replace. Activation uses same-filesystem atomic
renames under the private data root and writes a local import receipt containing
source identity, selected categories, validation results, hashes, and time. The
receipt contains no conversation or memory content.

Rollback is an explicit maintenance action that verifies the receipt and backup
digests, restores the prior destination entries atomically, and leaves both the
imported snapshot and original source available until the user separately asks
to remove them. Crash recovery either completes a fully validated activation or
restores the prior generation; it must never infer success from a partial copy.

## Required importer tests

Before implementation can be enabled, synthetic tests must cover dry-run with
zero writes, explicit consent, source immutability, destination conflict refusal,
schema and digest rejection, live-WAL handling, symbolic-link and hard-link
attacks, interruption at every activation boundary, rollback, low disk space,
permission failure, and category-specific re-approval. Tests must also prove
that merely configuring or launching with a desktop data root performs no
legacy-data discovery or mutation.
