# Security and privacy policy

## Reporting a vulnerability

Do not open a public issue for vulnerabilities, leaked private content, or
credentials. Use GitHub's private vulnerability reporting for this repository.
Include the affected version, reproduction steps, and potential privacy impact.

## Supported versions

| Version | Supported |
| --- | --- |
| 1.2.x | Yes |
| Earlier source releases | No |

Security fixes land on the latest `main` branch and are included in supported
source releases. Signed desktop distribution has a separate acceptance gate;
the source-version table does not claim that a platform package is supported.

The 1.2.0 release gate reports zero production dependency advisories with
`npm audit --omit=dev`. The Electron Forge development packaging chain still
contains upstream transitive advisories in archive, temporary-file, and image
tooling. The latest stable Forge release does not currently provide a clean
non-breaking resolution, so these findings remain disclosed and tracked rather
than hidden by an unsafe forced downgrade. Build only governed source and do
not feed untrusted archives or image assets to the development toolchain.

## Rangabot's privacy boundary

Rangabot is local-first, not magically isolated. Its runtime binds to
`127.0.0.1`, accepts only explicit loopback Host values, and permits only a
loopback Ollama endpoint. Chats, memories, Knowledge Vault material, embeddings,
approved paths, datasets, artifacts, and evaluation results remain on the local
computer and are Git-ignored. Cloud handoff and runtime web access remain
disabled.

The browser boundary uses two purpose-separated, signed capabilities. The
launcher prints a fresh bootstrap URL whose token stays in the URL fragment and
therefore is not sent in an HTTP request target. A minimal local page removes
that fragment from browser history, exchanges it through an exact same-origin
POST, and redirects to the clean app URL. Only that exchange can issue the
per-launch browser-session cookie; merely reaching the loopback port is not
authorization. Do not share the printed startup URL. A restart invalidates both
capabilities.

Strict Host, Origin, Fetch Metadata, content-type, and request-size checks block
ordinary cross-site requests, CSRF, and DNS-rebinding attempts against the local
API. Every private API response is non-cacheable. Model-authored Markdown cannot
load remote images, and the Content Security Policy blocks unapproved external
resources.

App chat generation is process-locally bounded to one active generation and
four queued requests per resolved model. This gate does not cover the separate
Knowledge ingestion/embedding CLI. Stop aborts the server-owned in-flight turn, not only
the visible browser request. Buffered responses, error bodies, streamed wire
data, partial lines, emitted output, chunks, and lines are all bounded; overflow
cancels the reader and becomes a typed resource-limit failure. Provider
timeouts, cancellation, empty output, and busy state remain typed and visible.
Default Ollama limits are 120 seconds per provider request, 2 MiB for a buffered
body, 64 KiB for an error body, 8 MiB streamed wire data, 1 MiB/1,048,576
characters of emitted output, 256 KiB for one partial line, and 32,768 stream
chunks or lines. The five-minute durable-turn stale deadline is recovery policy,
not extra provider runtime; the earliest active timeout wins.

On POSIX systems Rangabot enforces owner-only `0700` directories and `0600`
files for its managed SQLite stores and sidecars. SQLite secure deletion is
enabled for future row deletion. Private evaluation results and checkpoints use
the same owner-only atomic-write boundary. Approved repository access is bound
to the canonical directory identity and revalidated immediately before bounded
file reads; root replacement and symlink traversal require a fresh approval.
Approved datasets are additionally bound to their file identity and SHA-256,
then opened through a private immutable execution snapshot of the exact checked
bytes. A changed or legacy path-only approval requires explicit reapproval.
The isolated SQL worker has a 128 MiB JavaScript heap and 256 MiB DuckDB cap;
results are limited to 200 rows, 64 columns, 64 KiB per cell and 1 MiB total,
while schema transfer is limited to 500 columns and 256 KiB. Exceeding a limit
fails visibly as `resource-limit` rather than returning partial evidence.

Knowledge index database backups use SQLite's online backup API, owner-only files,
structural validation, and SHA-256 sidecars. Restore validates and stages the
candidate, retains a recovery copy, and holds the same cross-process lease as
the app. Original source/inbox books are not included. Legacy backups without a
sidecar receive structural validation but cannot prove historical checksum
integrity. Conversation deletion stages exclusively owned Word artifacts in a
private same-filesystem quarantine, restores them if the database transaction
rolls back, and purges only after commit. Interrupted pending batches are
restored or purged from authoritative database references; an unresolved
post-commit cleanup is surfaced and retried when the database next initializes.

Run this after upgrading an existing installation to repair permissions without
reading or deleting private content:

```bash
npm run privacy:repair
```

The repair and private-storage writers validate every existing path component
below an explicit trusted app root. If an intermediate component is a symbolic
link, that managed path is rejected or skipped before traversal or permission
changes; the link target is never repaired.

## What this boundary does not claim

Rangabot cannot protect data from malware or another process already running as
the same operating-system user, an administrator, physical access to an
unencrypted disk, operating-system/cloud backups, or storage-device remanence.
Use FileVault or equivalent full-disk encryption and protect the OS account.

SQLite logical deletion and `secure_delete` are not a guarantee that historical
copies have disappeared from existing WAL files, old backups, snapshots, or
SSD wear-levelled blocks. A separately reviewed purge workflow is required for
best-effort historical erasure. Revoking an approved dataset or repository stops
future Rangabot access; it never deletes the external source.

The browser capability is a local-origin protection boundary, not an operating-
system account sandbox. A process running as the same user can still access
local files, browser state, or the loopback service and is outside this threat
model.

The local model and its output are untrusted. Review code, queries, documents,
and consequential advice before use. Do not add a remote model endpoint, browser
telemetry, analytics, external images, web integrations, or cloud handoff
without a new visible approval and privacy review.

## Contributor and release requirements

- Never commit `.env*`, credentials, private keys, databases, local allowlists,
  Knowledge Vault material, artifacts, evaluation outputs, or personal paths.
- Use synthetic fixtures only in tests and public screenshots.
- Keep third-party GitHub Actions pinned to reviewed immutable commit SHAs.
- Run `npm run privacy:check`, `npm run check`, and
  `npm audit --omit=dev` before release.
- If a real credential is committed, rotate or revoke it first. Removing the
  latest file is insufficient; coordinate a full-history rewrite and assume old
  clones may retain it.
- Treat `npm run privacy:check` as a bounded known-pattern safeguard, not proof
  that every binary or unknown secret format is clean.
- The public `rangabot.com` site is informational. Its maintainer-local,
  Git-ignored Sites source is outside the current tracked application tree and
  may contain only synthetic, public, merged evidence.
