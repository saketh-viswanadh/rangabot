# Windows desktop candidate

RangaBot now has an implemented Windows 10/11 x64 candidate path intended to produce:

- a per-user Squirrel `Setup.exe` with governed install, shortcut, update-event, and uninstall lifecycle handling;
- a ZIP tester artifact for controlled clean-VM acceptance;
- a platform-qualified artifact manifest and distributable SHA-256/size evidence.

This is an **unsigned candidate**, not a public Windows release. Exact package bytes remain ineligible for a release-known claim until Authenticode signing, timestamp verification, SmartScreen-aware clean-machine acceptance, and tester evidence are complete. The candidate therefore reports `dirty / distribution-unsigned` even when every sealed byte matches.

Current evidence state: source compilation and a Windows package build have
passed, but the first generated `Setup.exe` was only 320 KB and therefore could
not be a self-contained installer for the 1.62 GB full package. The unretained
file's resource table was not directly inspected; the exact internal payload is
`NOT INSPECTED`, while Squirrel's source-backed embedding failure is the leading
diagnosis. That installer is invalidated and must not be downloaded or
published. The repaired large-payload build, installer
launch, close, update, and uninstall acceptance are **NOT RUN** until the branch
workflow and clean Windows VMs produce exact evidence.

## Local-first behavior

The package embeds the checksum-pinned Ollama v0.32.9 Windows runtime, but no model weights. At launch it detects a safe existing `%USERPROFILE%\.ollama\models` store and uses it in place without copying. If that store is absent or unsafe, it creates an app-private model directory under Electron's per-user AppData root. The local web server and model runtime bind only to `127.0.0.1`.

The official Windows runtime archive is about 1.36 GB before packaging because it includes Windows inference backends. The build records final Setup/ZIP sizes and fails if any distributable reaches GitHub's 2 GiB per-asset limit; size must be disclosed in any future download UI.

## Large-payload Squirrel experiment

Squirrel.Windows 2.0.1 embeds the complete full package into `Setup.exe`. Its
stock `WriteZipToSetup.exe` helper and `Setup.exe` template are both 32-bit and
not large-address-aware, while both handle the complete embedded ZIP in one
process address space. The Windows candidate therefore stages an isolated copy
of electron-winstaller 5.4.4's vendor directory and sets only the COFF
`IMAGE_FILE_LARGE_ADDRESS_AWARE` bit on those two exact locked binaries. The
build verifies the package-lock integrity, complete original and staged vendor
inventories, both binaries' original and patched hashes, PE32/i386 shape, and
single-byte difference before Squirrel runs. It never edits `node_modules`.
electron-winstaller's npm install script creates host-specific `7z.exe` and
`7z.dll` aliases; those two generated alias paths are excluded from the locked
package-owned source inventory, then deterministically regenerated from the
exact hashed x64 vendor files and included in the complete prepared inventory.

This is an explicitly bounded compatibility experiment, not a release
architecture claim. The distributable verifier streams the final PE `DATA`
resource 131 / language 0x0409, validates its ZIP directory and CRCs, requires
the exact generated full NUPKG SHA-256 and size, requires the locked
`Update.exe`, and reconciles the embedded and external `RELEASES` line. A small bootstrap
stub, missing resource, mismatched package, malformed ZIP, or non-LAA output
fails the workflow. Even a structurally valid result still needs repeated
low-memory clean-VM install, update, uninstall, and relaunch testing before it
can be considered usable. Squirrel.Windows and electron-winstaller MIT notices
are preserved in `THIRD_PARTY_NOTICES.md`.

The verifier also opens that exact full NUPKG and requires its
`lib/net45/RangaBot.exe` and packaged desktop manifest to match the separately
sealed application and manifest bytes. Case-insensitive package-path collisions,
unsafe paths, or a package that would install different bytes fail closed.

## Reproducible build route

Run on a clean Windows x64 host with Node 24. After Electron fuses are flipped,
the build parses the PE header directly and requires the embedded certificate
table to be absent before sealing the candidate. The pinned Electron archive
has no embedded PE certificate table. Any future input with one fails
closed and requires an explicit signing-policy review; the candidate build does
not silently strip or rewrite signatures. This byte-level check does not claim
that the host has no external catalog association, and it is not a substitute
for final Authenticode signing and clean-machine trust testing:

```powershell
npm ci
npm run check
npm run desktop:make:windows:x64
node --experimental-strip-types scripts/verify-windows-distributables.ts
```

The `Windows desktop candidate` workflow follows the same route and never creates a GitHub Release or changes the website. It retains only the two public-safe JSON identity/checksum records for seven days. Setup, ZIP, NUPKG, model, and private-data bytes are not uploaded or published by this workflow.

## Required acceptance before release

1. Verify the artifact manifest, PE x64 inventory, fuse wire, runtime checksums,
   final distributable checksums, both exact LAA-only vendor mutations, and the
   Setup-embedded full-package hash.
2. Install, launch, close, relaunch, update, and uninstall repeatedly in clean
   Windows 10 and Windows 11 VMs using synthetic data only, including a
   constrained-memory run.
3. Confirm AppData profile persistence across update, explicit profile deletion reclamation, in-place existing-model reuse, no model downloads without user action, and no orphaned RangaBot/Ollama process tree after exit.
4. Add and verify Authenticode signing/timestamping; rebind exact signed bytes and retest SmartScreen behavior.
5. Only then publish GitHub and website downloads with exact size, checksum, signature, system requirements, and honest release status.
