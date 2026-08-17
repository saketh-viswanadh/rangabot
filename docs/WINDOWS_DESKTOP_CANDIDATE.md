# Windows desktop candidate

RangaBot has a governed Windows 10/11 x64 application-package path. The build
first finalizes the Electron application, then uses the pinned Windows SDK
`MakeAppx.exe` directly to create one MSIX. Forge also creates a ZIP for
diagnostic testing; the ZIP is not the recommended installer.

This is an **unsigned internal candidate**, not a public Windows release. It is
not an easy double-click install, it has no automatic updater, and it must not
be linked from the website or attached to a GitHub Release. Microsoft limits
unsigned executable MSIX testing to Windows 11 with an elevated
`Add-AppxPackage -AllowUnsigned` command. Windows 10 and ordinary-user install
acceptance require a trusted, timestamped signature.

Current evidence state: source tests pass on macOS, but the direct MSIX has not
yet been produced or inspected on the pinned Windows SDK. Installation,
launch, close, relaunch, upgrade and uninstall are **NOT RUN**. The workflow
retains only public-safe JSON evidence; it does not upload MSIX or ZIP bytes.

## Why the installer changed

The earlier Squirrel large-payload experiment is retired. Squirrel completed a
make step, but its final `Setup.exe` failed the required embedded `DATA/131`
payload proof. That output was invalidated and was never published. RangaBot
does not weaken the verifier or retain a second Squirrel installer path.

Direct MSIX avoids a custom downloader and gives Windows a block map for the
complete package. The verifier independently streams the ZIP container,
rejects unsafe or colliding Windows paths, reconciles every application file
with `AppxBlockMap.xml` SHA-256 evidence, proves that the exact finalized
desktop artifact and provenance manifest are inside, and requires the unsigned
container to contain no package-signature file. Structural verification is not
installability or release evidence.

## Local-first data behavior

The package embeds the checksum-pinned Ollama v0.32.9 Windows runtime but no
model weights. It uses a safe existing `%USERPROFILE%\.ollama\models` store in
place without copying. If no safe shared store exists, model downloads require
an explicit user action and go only to the package-owned private data root.

The internal package identity is `RangaBot.InternalCandidate`; its package
family is `RangaBot.InternalCandidate_d8tfa9dph86fg`. Packaged startup must
bind Electron-owned state to that family's `LocalState`/`LocalCache` before any
private write, and must never read or migrate the unpackaged
`%APPDATA%\Rangabot` tree. Package uninstall is expected to remove package-owned
state. The shared Ollama model store, user-selected Knowledge files and exported
backups are external user data and must remain untouched.

The local web server and managed model runtime bind only to `127.0.0.1`. The
official Ollama archive is about 1.36 GB before packaging, so the final MSIX is
strictly required to remain below GitHub's 2 GiB per-asset boundary. Exact size
must be measured and disclosed before any later release.

## Reproducible internal build route

Run on a clean Windows x64 host with Node 24 and Windows SDK
`10.0.26100.0`. The SDK path, version, SHA-256 and valid Microsoft signature
are recorded before `MakeAppx.exe` runs. Semantic validation and SHA-256 block
maps are mandatory; overwrite and validation-disable switches are forbidden.

```powershell
npm ci
npm run check
$env:RANGABOT_EXPECTED_SOURCE_SHA = (git rev-parse HEAD)
npm run desktop:make:windows:x64
npm run desktop:msix:verify
```

Successful source-level packaging produces:

- `out/make/msix/win32/x64/RangaBot-win32-x64-0.1.0.msix`
- `desktop/out/windows-msix-build-win32-x64.json`
- `desktop/out/windows-msix-win32-x64.json`
- the existing platform-qualified desktop artifact evidence

The final JSON must still say `unsigned-candidate`, `publicReleaseEligible:
false`, and `cleanVmAcceptance: NOT_RUN`. A build success does not authorize
distribution.

## Required acceptance before release

1. Retain the structurally verified internal unsigned MSIX only as validation
   evidence; record its source commit, desktop artifact ID, MakeAppx identity,
   block map, size and SHA-256.
2. Create an approved production manifest and package identity whose Publisher
   exactly matches the approved signing certificate subject and omits the
   internal unsigned-package OID. Rebuild it from the same sealed post-fuse
   application/source with the pinned MakeAppx, then structurally verify the
   rebuilt unsigned-before-signing bytes.
3. Sign and timestamp that production package. A future signature-aware final
   verifier must prove its manifest and decoded application identity, trusted
   chain and timestamp, signature coverage, exact final SHA-256 and zero
   post-sign mutation; the current internal verifier intentionally accepts only
   unsigned candidate packages.
4. On clean standard-user Windows 10 and Windows 11 x64 VMs, install, launch,
   finish onboarding, close, relaunch, upgrade and uninstall the exact signed
   bytes. Run Windows App Certification Kit and Defender/SmartScreen checks.
5. Confirm loopback-only listeners, no unsolicited model download, no orphaned
   RangaBot/Ollama processes, package-owned private state, and in-place reuse of
   existing models without copied bytes.
6. Seed package-owned data, a shared model store, a user-selected Knowledge
   file and an exported backup. After uninstall, prove package-owned state is
   removed and every external user-controlled byte is unchanged.
7. Only after those gates pass, create a new versioned GitHub release and update
   the website with exact architecture, requirements, size, checksum, signature
   status, install/uninstall instructions and known limits.

Microsoft references: [unsigned package testing](https://learn.microsoft.com/windows/msix/package/unsigned-package),
[MakeAppx](https://learn.microsoft.com/windows/msix/package/create-app-package-with-makeappx-tool), and
[MSIX on Windows 10 and Windows 11](https://learn.microsoft.com/windows/apps/package-and-deploy/msix-windows10-windows11).
