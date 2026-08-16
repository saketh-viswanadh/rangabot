# Windows desktop candidate

RangaBot now has an implemented Windows 10/11 x64 candidate path intended to produce:

- a per-user Squirrel `Setup.exe` with governed install, shortcut, update-event, and uninstall lifecycle handling;
- a ZIP tester artifact for controlled clean-VM acceptance;
- a platform-qualified artifact manifest and distributable SHA-256/size evidence.

This is an **unsigned candidate**, not a public Windows release. Exact package bytes remain ineligible for a release-known claim until Authenticode signing, timestamp verification, SmartScreen-aware clean-machine acceptance, and tester evidence are complete. The candidate therefore reports `dirty / distribution-unsigned` even when every sealed byte matches.

Current evidence state: source compilation and cross-platform tests can run on development hosts; Windows package, installer, launch, close, update, and uninstall acceptance are **NOT RUN** until the branch workflow and clean Windows VMs produce exact evidence.

## Local-first behavior

The package embeds the checksum-pinned Ollama v0.32.9 Windows runtime, but no model weights. At launch it detects a safe existing `%USERPROFILE%\.ollama\models` store and uses it in place without copying. If that store is absent or unsafe, it creates an app-private model directory under Electron's per-user AppData root. The local web server and model runtime bind only to `127.0.0.1`.

The official Windows runtime archive is about 1.36 GB before packaging because it includes Windows inference backends. The build records final Setup/ZIP sizes and fails if any distributable reaches GitHub's 2 GiB per-asset limit; size must be disclosed in any future download UI.

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

1. Verify the artifact manifest, PE x64 inventory, fuse wire, runtime checksums, and final distributable checksums.
2. Install, launch, close, relaunch, update, and uninstall in a clean Windows 10 and Windows 11 VM using synthetic data only.
3. Confirm AppData profile persistence across update, explicit profile deletion reclamation, in-place existing-model reuse, no model downloads without user action, and no orphaned RangaBot/Ollama process tree after exit.
4. Add and verify Authenticode signing/timestamping; rebind exact signed bytes and retest SmartScreen behavior.
5. Only then publish GitHub and website downloads with exact size, checksum, signature, system requirements, and honest release status.
