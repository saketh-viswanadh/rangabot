# Mac App Store distribution

Status: **the App Store path is included in the 1.2.0 source release.** An
earlier 0.1.0 beta was signed and submitted to TestFlight Beta App Review; that
historical submission is not evidence for 1.2.0. Signing, package creation,
TestFlight installation, App Review, and public distribution for the exact
1.2.0 package are **NOT RUN**.

The App Store edition is a separate Electron `mas` build. It does not replace
or silently change the direct-download `darwin` edition.

## Product boundary

- Bundle identifier: `com.rangabot.desktop`.
- Marketing version: `1.2.0`.
- Initial source-controlled Mac build number: `1.2.0`. Confirm it is greater
  than every previously uploaded Mac build before the first upload; increment
  only this build number for each replacement upload while the marketing
  version remains `1.2.0`.
- Initial price: free.
- Initial architecture candidate: Apple silicon (`arm64`). Intel and a universal
  package remain a separate release decision and are not implied by this build.
- Electron: exact `43.4.0` MAS archive, SHA-256
  `8037c385407a2efc9b85b0d1b39121735571e0bc6a00eb44d29c1873fbe1a9d3`.
- Ollama: the exact governed runtime is bundled as signed child code. Model
  weights are not bundled by this packaging change.
- Managed model downloads stay in RangaBot's sandboxed private data. The App
  Store edition never probes `~/.ollama/models` automatically.
- External documents, datasets, and repositories require a native user choice.
  App-scoped security-scoped bookmarks retain that explicit permission.
- RangaBot and Ollama remain loopback-only. Owned server and model-runtime
  process trees must stop when the app quits.
- Updates for this edition come only from the Mac App Store.

## Required Apple setup

1. Install full Xcode and either select it with `xcode-select` or set
   `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` for each release
   command.
2. Sign in to the enrolled Apple Developer account in Xcode.
3. Create Apple Development and Apple Distribution certificates.
4. Create a Mac Installer Distribution certificate (or retain a valid legacy
   `3rd Party Mac Developer Installer` identity) for the App Store package.
5. Register the explicit App ID `com.rangabot.desktop` with App Sandbox.
6. Create matching Mac App Store development and distribution provisioning
   profiles and download them locally.
7. Create the RangaBot record in App Store Connect with the same bundle ID.

Certificates, profiles, private keys, Apple credentials, API keys, and
app-specific passwords must remain in Keychain/App Store Connect and must never
be committed.

## Development package

```sh
export RANGABOT_MAC_TEAM_ID='YOURTEAMID'
export RANGABOT_MAC_APP_SIGNING_IDENTITY='Apple Development: Your Name (YOURTEAMID)'
export RANGABOT_MAC_PROVISIONING_PROFILE='/absolute/path/RangaBot_MAS_Development.provisionprofile'
npm run desktop:mas:package:development:arm64
```

The build fails closed if the target, pinned Electron archive, profile path,
identity, Team ID, entitlements, nested signatures, fuse wire, source identity,
or final deep-signature verification disagrees.

## Distribution package

```sh
export RANGABOT_MAC_TEAM_ID='YOURTEAMID'
export RANGABOT_MAC_APP_SIGNING_IDENTITY='Apple Distribution: Your Name (YOURTEAMID)'
export RANGABOT_MAC_PROVISIONING_PROFILE='/absolute/path/RangaBot_MAS_Distribution.provisionprofile'
export RANGABOT_MAC_INSTALLER_SIGNING_IDENTITY='Mac Installer Distribution: Your Name (YOURTEAMID)'
npm run desktop:mas:make:arm64
```

Each signing-identity value may instead be the exact 40-hex SHA-1 fingerprint
shown by `security find-identity -v`. The verifier resolves both values to
certificate/private-key identities, binds the team through certificate subject
OU and `codesign` TeamIdentifier, and binds the package to the resolved
installer certificate's SHA-256 fingerprint.

The resulting `.pkg` is a submission artifact, not proof of installability or
approval. A distribution-signed `.app` normally cannot be launched directly;
Apple must re-sign it through TestFlight or the store.

Forge gives the installer a build-specific name such as
`RangaBot-1.2.0-build-1.2.0-arm64-Mac-App-Store.pkg`. The source-controlled
`package.json` values, packaged plist, desktop artifact manifest, and final
package evidence must all agree on both version identities.

## Acceptance before upload

The exact signed candidate must pass all of the following on a clean account or
VM:

1. Development-signed installation and first launch.
2. App Sandbox receipt and entitlement inspection.
3. Onboarding with no pre-existing RangaBot or Ollama state.
4. Managed Ollama readiness on `127.0.0.1` only.
5. Explicit model download, restart, and model reuse from sandbox storage.
6. Document, dataset, and repository selection through the native picker.
7. Relaunch with restored security-scoped permission and revocation behavior.
8. Chat, Knowledge Vault, SQL analysis, DOCX creation, and profile backup.
9. Quit with no surviving owned server, SQL worker, preview helper, or Ollama
   process.
10. TestFlight install, launch, relaunch, update, and uninstall.
11. Confirmation that unrelated files and an external `~/.ollama` store remain
    untouched.
12. Full `npm run check`, package identity verification, and privacy scan.

Any failed item keeps submission and public claims on hold.

## App Store Connect draft

- Name: RangaBot
- Subtitle: Private local AI on your Mac
- Primary category: Productivity
- Price: Free
- SKU: `rangabot-macos-001`
- Privacy policy: `https://rangabot.com/privacy`
- Support URL: must be confirmed live before submission

The privacy questionnaire must be answered from a final runtime/network audit,
not from product intent. Review notes should explain the bundled local Ollama
helper, local model assets, loopback listener, user-selected file permissions,
and absence of a mandatory cloud account.

## Upload and release

After the acceptance matrix passes:

1. Validate and upload the `.pkg` with Apple's current tools.
2. Wait for processing and resolve every warning.
3. Distribute through TestFlight for Mac and repeat install/update/uninstall
   validation on the processed build.
4. Complete screenshots, description, age rating, export compliance, App
   Privacy, review contact, and review notes.
5. Submit for App Review.
6. Only after Apple approval, update rangabot.com and GitHub with the final App
   Store URL and accurate supported-hardware statement.

Do not upload an unsigned package, publish a development build, or claim the
App Store edition is available before Apple approval and the public listing are
independently observed.
