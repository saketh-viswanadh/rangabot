# macOS desktop development foundation

Status: unreleased development work. The commands here produce unsigned,
ad-hoc-signed local artifacts only. They do not create a released build, prove
notarization or Gatekeeper distribution, or update `company/state/current_build.json`.

## Architecture and security boundary

The macOS shell uses Electron 43 and a supervised Electron utility process to
run the existing Next.js standalone server. It binds an operating-system chosen
port on `127.0.0.1`, authenticates readiness with a launch-only challenge, and
opens the existing product through its fragment bootstrap flow. A desktop
bootstrap token is consumed once. The renderer has `contextIsolation`, sandbox
and `webSecurity` enabled, with Node integration, remote navigation, new windows,
permissions and unapproved downloads denied.

The packaged app has two independent roots:

- `RESOURCE_ROOT` is the immutable, identity-verified application payload.
- `DATA_ROOT` is owner-private mutable state below Electron's `userData` path.

The server receives both roots explicitly. Current working directory is not a
packaged-runtime path authority. Conversations, memories, Knowledge state,
dataset and repository registries, SQL confirmations and snapshots, artifacts,
feedback, preferences, temporary files and the runtime lease remain under
`DATA_ROOT`. Next standalone files, public/static assets, package metadata,
Knowledge briefs and the SQL worker are read from `RESOURCE_ROOT`.

Existing CLI data is not discovered, copied, merged, moved or deleted on desktop
startup. The reversible future import design is in
[`DESKTOP_DATA_IMPORT_DESIGN.md`](DESKTOP_DATA_IMPORT_DESIGN.md).

## Normal development artifact

The normal artifact keeps RangaBot's existing local capabilities. Ollama remains
an independently installed loopback prerequisite and is never bundled or
downloaded by the app.

```sh
npm run desktop:package:arm64
```

An x64 command exists for architecture-specific engineering work, but parity is
not established unless that architecture's Electron runtime and native DuckDB
and sqlite-vec payloads independently load and pass packaged tests.

## Finder verification-only artifact

The Guardian/Sentinel verification artifact is deliberately a different app:

- display/executable name: `RangaBot Verification`
- bundle identifier: `com.rangabot.desktop.verification`
- build command: `npm run desktop:package:verification:arm64`
- output: `out/RangaBot Verification-darwin-arm64/RangaBot Verification.app`
- evidence: `desktop/out/desktop-artifact-verification-arm64.json`

Its exact manifest-bound launch profile is:

```json
{
  "kind": "finder-synthetic-v1",
  "profileId": "rbv-arm64-20260812-v1",
  "applicationSupportRelativePath": "RangaBot Verification/rbv-arm64-20260812-v1",
  "capsuleMarkerSha256": "16fc967456de08b08f158f12c7967bc035c9ddde564972799dc70bd1ffcee6a8",
  "externalFilesystemAccess": "deny",
  "localModelPolicy": "disabled"
}
```

The installed runtime never selects this profile from arguments, environment,
URLs, file-open events, renderer IPC or preferences. It reads the profile only
after cryptographic verification of the immutable app manifest. The normal app
has `{ "kind": "normal" }` and cannot select or recognize the verification
capsule.

The verification capsule must already exist at the sealed path below the
current account's Application Support directory. No production provisioner is
included. Its owner-only top-level layout is exactly:

```text
RangaBot Verification/rbv-arm64-20260812-v1/
  capsule-profile.json
  userData/private-data/tmp/
  sessionData/
  logs/
  crashDumps/
```

`capsule-profile.json` contains the exact single-line JSON profile marker used by
`finderVerificationCapsuleMarkerBytes()`. Missing, mismatched, non-owner,
public-mode, hard-linked, symbolic-linked, non-directory or unexpected
capsule content fails closed with no fallback to normal RangaBot paths and no
automatic provisioning or repair.

Startup ordering for this artifact is fixed:

1. Verify immutable artifact, resources, native payloads and runtime identity.
2. Validate the exact sealed profile.
3. Validate the pre-existing capsule read-only.
4. Bind Electron `userData`, `sessionData`, `logs` and `crashDumps` to its
   pre-existing subdirectories.
5. Read-only preflight empty/missing repository and dataset registries.
6. Acquire the single-instance lock, then reserve the loopback port, create
   application state, acquire the runtime lease and start the backend/UI.

The verification backend inherits only non-secret locale/timezone values. It
does not inherit ambient `HOME`, `PATH`, Ollama/model settings, proxy/debug
settings, `NODE_OPTIONS`, inspectors or arbitrary `RANGABOT_*` values. The shell
adds only its verified roots, private temporary root, exact denial policies,
loopback port and fresh session/bootstrap/readiness capabilities.

The `deny` policy rejects repository approvals and reads, dataset approvals and
SQL, conversation/memory imports, and non-empty persisted approval registries
before an external target is opened. Knowledge and artifact reads remain
ID/fixed-path operations under the governed roots. This is application-path
enforcement, not Apple App Sandbox or absolute operating-system confinement.
Finder verification involving the strongest no-real-data claim still requires a
dedicated clean macOS account or VM; this repository does not create one.

## Identity and packaging evidence

The final per-architecture manifest binds the baseline commit, complete source
snapshot, dependency lock, old web-feedback identity, launch profile,
Electron/embedded Node/Next/native versions, fuse policy, full `Contents`
bundle inventory, complete `Resources` inventory and every native payload.
Canonical JSON recursively byte-sorts keys; file inventories use byte-sorted
POSIX-relative paths, byte lengths and lowercase SHA-256 digests. `generatedAt`
is evidence metadata and is excluded from the derived artifact ID.

After Forge packaging, finalization removes inherited broad ATS and unused
camera, microphone, audio and Bluetooth plist declarations; directly reads and
compares all nine named Electron fuses; restores an ad-hoc signature; hashes the
post-mutation bundle/resources/native payloads; writes the manifest; seals the
outer app; then rechecks the signature, fuse wire and exact identity. Any
mismatch blocks the artifact.

A development artifact built from uncommitted source records `sourceDirty: true`.
It may be internally intact but is not current/released evidence, and response
feedback remains ineligible for known-build aggregation.
