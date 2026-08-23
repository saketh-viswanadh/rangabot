# RangaBot Profiles v1

Status: local implementation candidate only. Profiles v1 is not released, is
not a statement about the governed current build, and has not yet received
independent Sentinel, Guardian, or CUO verification.

Profiles are local workspaces. They are not accounts, sandboxes, encryption
boundaries, or operating-system security boundaries. Their purpose is to keep
RangaBot work organized and to prevent one profile's product-managed state from
appearing in another profile during normal application use.

## Identity and layout

Every profile has a canonical opaque UUID. A display-name change never changes
that UUID. Exactly one profile has the protected `default` identity and retains
the permanent `Default` marker even when its display label is renamed. A
`testing` profile is displayed as `Testing · Temporary`; the marker does not
imply automatic expiry or secure deletion.

The desktop-supplied `DATA_ROOT`, or the existing CLI `./data` root, is the
managed root. The version-one layout is:

```text
<managed-root>/
  profiles-v1/
    registry.json
    registry.recovery.json
    registry.lock                 # present only during a registry mutation
    operation-recovery.json       # present only while lifecycle Recovery is required
    data/<profile-uuid>/           # all profile-owned product data
    recovery/                      # Default-adoption recovery manifests
    tombstones/                    # bounded reset/delete staging
  models/                          # shared model-runtime material, never copied
  rangabot.db-runtime.lock         # process-level runtime ownership
  tmp/                             # process-level desktop temporary work
```

`registry.json` is schema-versioned and records the protected Default UUID,
active UUID, profile display/type metadata, and a monotonic generation. Registry
writes use an owner/start-identity lock, a private temporary file, `fsync`, and
atomic rename. A validated recovery generation can be selected read-only and
repaired only through an explicit recovery operation.

Lifecycle operations journal their exact profile, operation UUID, prior
generation, phase, stage/root/tombstone identity, and bounded timestamps before
the first filesystem cutover. If the process stops after a cutover, normal
workspace access remains blocked and the two recovery-only endpoints accept
only a journal-bound pre-operation or current signed profile capability. The
user must explicitly recover the validated state before ordinary work resumes.

The registry and its layout never accept a renderer- or request-supplied
filesystem root. Existing symbolic-link components, traversal, unsafe owner
permissions, and unexpected hard links are rejected at the storage boundary.

## Mutable and shared domain inventory

The active profile is resolved at use time. Long-lived SQLite handles close and
reopen when the resolved active path changes.

| Domain | Profile-owned location | v1 behavior |
| --- | --- | --- |
| Conversations, messages, lifecycle turns, response feedback | `rangabot.db` | One SQLite database per profile; feedback remains attached to its canonical turn. |
| Memory | `rangabot-memory.db` | One SQLite database per profile. |
| Knowledge source inbox, processed files, indexes, backups, evaluation results | `knowledge/` | Files and Knowledge SQLite/vector indexes are profile-owned. Immutable built-in source manifests and briefs remain resources. |
| Repository approvals | `repositories.json` | Approval metadata is per profile. Referenced repositories remain external and are not copied. |
| Dataset approvals and derived snapshots | `datasets.json`, `dataset-snapshots/` | Approval and managed derived data are per profile. Original datasets remain external and are not copied. |
| SQL confirmations | `sql-confirmations.json` | Confirmation capability records are per profile and excluded from backup. |
| User, appearance, welcome, and model-selection preferences | `desktop-preferences.json`, `model-preferences.json` | Durable preferences are server-managed in the profile root, so an ephemeral loopback port does not lose them. Model selection is per profile. |
| Managed documents and other artifacts | `artifacts/` | Product-created artifacts are per profile. External source files are not adopted implicitly. |
| Conversation and Knowledge evaluation output | `evaluations/`, `knowledge/evaluations/results/` | Generated evidence is routed through the active profile root. |
| Operational logs and credentials | reserved per-profile domains | No general credential vault is implemented in this candidate. Credentials remain excluded from backup; adding a credential-bearing integration requires an explicit per-profile namespace and fail-closed review. |

Only these classes are shared:

- immutable files beneath `RESOURCE_ROOT`;
- validated current-user Ollama discovery and the existing model weight/blob
  store in place;
- non-content-bearing process ownership and temporary shell state needed to run
  one local application instance;
- the minimal profile registry metadata needed to select a workspace.

Profile creation, rename, switch, reset, delete, backup, or restore must never
copy, move, export, or delete Ollama weights. Installed-model visibility is
shared; selected model and context preferences are profile-owned.

## Setup and Default adoption

Profile setup is explicit. Before consent the legacy managed root remains in
use and registry inspection is read-only. The user-facing preflight copy is:

> Your existing RangaBot data will become the protected Default profile.

After confirmation, setup:

1. closes open profile SQLite resources;
2. inventories the legacy managed data without following links or accepting
   hard-linked files;
3. excludes shared models, process temporary data, runtime locks, and any
   Profiles v1 metadata;
4. copies into a private staging directory and verifies per-file size/hash plus
   a deterministic aggregate inventory digest;
5. validates known SQLite stores with read-only `PRAGMA quick_check`, validates
   bounded application-owned JSON schemas, and rejects links, unsafe modes, and
   portable filename collisions;
6. writes an owner-private recovery manifest and operation journal;
7. atomically renames the staging directory to the Default UUID root; and
8. atomically creates the registry with that UUID active.

The original workspace is not moved, overwritten, or deleted and remains the
authoritative fallback until the staged copy and registry cutover verify. The
success copy is:

> Your existing workspace is ready in Default.

Copy, integrity, low-space, or registry-cutover failure removes only the unused
stage/profile copy. The original remains unchanged. The failure copy is:

> Profiles could not be set up. Your original RangaBot data was not replaced. You can retry or continue with the previous setup.

Merely discovering legacy data never starts migration.

## Lifecycle and stale-work protection

- Create makes an empty owner-private root; it never clones another profile.
- Rename changes display metadata only.
- Switch first stops new admission through the profile operation gate, requires
  no active writer, closes active SQLite handles, atomically changes the active
  registry generation, rotates the local session/profile capability, and
  reloads the source UI before input is enabled.
- Every local API request is bound to `profile UUID + registry generation`.
  Tokens, windows, requests, and background work carrying an older binding fail
  closed after create, rename, switch, reset, delete, or restore advances the
  registry generation.
- Generation, tool execution, import, export, indexing, dataset processing,
  artifact creation, database mutation, migration, backup, restore, reset, and
  delete are named operation classes. Any active class blocks a switch or other
  destructive lifecycle transition. The busy message identifies the operation
  and offers only Wait, safe Cancel where implemented, or Stay.
- A second process cannot mutate the registry while a live or unverifiable
  owner/start lock exists. Bounded stale recovery never kills a process.
- Supported offline indexing, Knowledge maintenance, evaluation, repair, and
  feedback-export processes take the same managed runtime lease, capture the
  exact profile UUID/generation/root, and recheck both that binding and pending
  Recovery before every write. A profile switch therefore cannot redirect an
  already-running maintenance process into a different workspace.

The active profile marker is supplied by the same `/api/profiles` state in the
source/web and desktop shell. The supported lifecycle API surface is:

```text
GET, POST       /api/profiles
POST            /api/profiles/setup
GET, PATCH,
DELETE          /api/profiles/<uuid>
POST            /api/profiles/<uuid>/switch
POST            /api/profiles/<uuid>/reset
GET             /api/profiles/<uuid>/backup
POST            /api/profiles/restore
POST            /api/profiles/recover
```

These routes accept identity and confirmation values, never profile-root paths.
The desktop shell and source/web server use the same server-side registry,
session binding, path derivation, and data stores. Electron does not expose
filesystem or process access to the renderer.

## Reset and deletion

The protected Default profile cannot be reset or deleted. The active profile
cannot be reset or deleted. Reset is limited to an inactive `Testing ·
Temporary` profile and requires its exact display name. Personal-profile delete
also requires the exact display name; the UI may first offer a backup.

Both operations first journal the exact operation and rename the verified UUID
root into the private tombstone area. Metadata is advanced atomically, and only
then is the journal-bound tombstone removed. An interruption or ambiguous lock
release never triggers an assumed rollback: ordinary access stays blocked until
explicit Recovery validates the registry, root, journal, and tombstone and then
either rolls back the uncommitted cutover or completes the committed cleanup. A
failed final purge is reported as cleanup pending; v1 does not promise forensic
or secure deletion. External repositories, datasets, and shared model weights
are outside the deletion scope.

## Backup, export, and restore

Backup v1 is a local, versioned JSON envelope with:

- source profile UUID, display name, and type;
- exact included/excluded category lists;
- canonical creation time;
- path, byte count, category, content SHA-256, and base64 bytes for each included
  regular file; and
- an SHA-256 over the complete canonical manifest payload.

The encoded backup is capped at 512 MiB. Credentials, operational logs, shared
models, temporary data, locks, active repository/dataset approvals, and live SQL
confirmations are excluded. Backup does not upload data.

Repository and dataset references are retained only as
`inactive-reapproval-required` metadata. Restore validates the complete schema,
manifest, file digests, path safety, exclusions, duplicates, size, known SQLite
integrity, and application-owned JSON schemas before registry mutation. It then
creates a new profile by default and never opens, validates, overwrites, or
silently reapproves an external target. The restored root keeps a bounded
`.rangabot-restore-origin.json` provenance seal for crash Recovery; that seal is
excluded from later backups. Interrupted restore is resolved from its durable
journal without guessing whether the registry commit occurred. Export remains
a separate, content-selective product action and is not described as a complete
backup.

In source/web mode the browser download remains local. In the desktop shell,
backup uses a narrow IPC contract and native Save dialog; it validates the
backup before the dialog, writes a same-directory private temporary file,
`fsync`s and verifies exact length/hash, publishes without overwrite, and
`fsync`s the destination directory on POSIX. Windows retains strict file
flushes, exact directory verification, no-overwrite publication, and Recovery
journals, but its filesystem API does not provide the same directory-entry
`fsync` boundary. A sealed verification-only desktop profile does not install
this IPC and rejects backup/restore before file bytes are read.

## Developer canaries

All profile tests use disposable synthetic roots and synthetic external
fixtures. They do not inspect a real RangaBot profile or an Ollama weight.

```bash
node --test --experimental-strip-types \
  tests/profile-registry.test.ts \
  tests/profile-operations.test.ts \
  tests/profile-recovery.test.ts \
  tests/profile-domain-validation.test.ts \
  tests/profile-maintenance.test.ts \
  tests/profile-migration.test.ts \
  tests/profile-backup.test.ts \
  tests/desktop-profile-backup-save.test.ts \
  tests/profiles-v1-integration.test.ts
```

`profiles-v1-integration.test.ts` exercises actual stores in two profiles:
conversation/feedback, memory, Knowledge, repository/dataset approvals,
preferences/model selection, artifacts, and SQL confirmations. It proves the
first profile is restored byte-for-state after switching back, the second starts
empty, old session/request bindings fail, all declared operation classes block
switching, backup-restored external references remain inactive, reset/delete
protections hold, failed Default adoption rolls back, the original remains
untouched, and the shared synthetic model marker hash does not change.

## Candidate limits and release gate

The unsigned arm64 development package uses the explicitly named
`electron-43-hardened-v2` fuse policy. Its required V1 wire is
`010011001`: index 6, `LoadBrowserProcessSpecificV8Snapshot`, remains disabled.
The Electron 43 arm64 payload does not include
`browser_v8_context_snapshot.bin`, and prior native launch testing found that
enabling index 6 without that file prevents startup before application code
runs. Packaging directly inspects all nine named fuse states after mutation and
after the final ad-hoc signature, and the installed manifest binds the policy
name, the disabled index, the exact wire, the original source merge, the
Profiles behavior commit, and the clean packaging commit. This is a documented
runtime-compatibility policy, not a release or signing claim.

For this candidate line, `sourceBaseCommit` is the original merged source
`8b161635f79ac6a572524ba22e3af7364fe08a5b` and
`sourceBaselineCommit` is the completed first-run onboarding, mobile review,
and Windows direct-MSIX, isolated MakeAppx attestation, and bounded OPC
and whole-file BlockMap verification, plus the sandboxed Mac App Store source
candidate, timestamp-sized Mach-O seal binding, schema-grounded SQL planning,
cross-platform Mac security test correction, profile-local dataset semantic
context with verified-usage retrieval, and governed capability routing with
truthful resource receipts and bounded mechanical Finish & Verify at commit
`09a3ad9ad14f895d495f78091cb21e138d563f62`.
The generated v3 manifest records
the exact clean packaging HEAD as `sourceCommit`; the installed verifier uses
that value as its commit identity and does not require `.git`.

- Profiles isolate normal product-managed paths; they do not prevent the Node
  main/backend process from technically accessing other local files. Existing
  repository and dataset access still depends on explicit approvals.
- A profile name is local metadata, not an authentication claim.
- No automatic expiry or secure erase exists in v1.
- No credential-bearing integration has yet proven a complete per-profile
  namespace. Credentials are excluded from backup and must fail closed until a
  concrete integration is reviewed.
- Backup is an in-memory JSON envelope with a 512 MiB encoded limit; it is not a
  streaming archival format.
- A source-level canary does not prove Finder, VoiceOver, crash, low-space, or
  packaged-desktop parity. Those remain explicit independent verification
  gates.
- Developer tests are not independent evidence. Sentinel must retest isolation,
  stale authorities, migration/restore corruption, concurrency, and packaged
  desktop behavior; Guardian must independently review privacy, trust wording,
  path escape, external-reference, and shared-model boundaries; CUO must verify
  profile visibility, focus, keyboard/VoiceOver semantics, waiting, exact
  confirmations, and truthful recovery copy.

Until those gates pass and governance promotes an exact immutable candidate,
`current_build` remains `UNKNOWN` and release remains `HOLD`.
