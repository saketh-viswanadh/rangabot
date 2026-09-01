# RangaBot Mac App Store build

This directory defines the least-privilege App Sandbox contract for the
Mac App Store variant. The bundle identifier is `com.rangabot.desktop`.

The App Store variant:

- uses Electron's `mas` runtime rather than the ordinary `darwin` runtime;
- keeps the managed Ollama model store inside RangaBot's sandbox container;
- never probes `~/.ollama/models` automatically;
- binds its HTTP services to loopback and stops their owned process trees when
  the application quits; and
- grants external file or folder access only through a native user selection,
  retaining that permission with app-scoped security-scoped bookmarks.

The main entitlement permits only App Sandbox, app-scoped bookmarks,
user-selected read/write access, and network client/server access. Child code
inherits those capabilities. Camera, microphone, USB, location, contacts,
calendar, Photos, and broad filesystem entitlements are intentionally absent.

## Required local inputs

Do not commit certificates, provisioning profiles, passwords, API keys, or
private keys. A build fails closed unless the following environment values are
provided:

- `RANGABOT_MAC_TEAM_ID`: exact 10-character Apple team identifier.
- `RANGABOT_MAC_APP_SIGNING_IDENTITY`: exact Keychain common name or 40-hex
  SHA-1 fingerprint for the app certificate/private-key identity.
- `RANGABOT_MAC_PROVISIONING_PROFILE`: absolute path to the matching Mac App
  Store provisioning profile.
- `RANGABOT_MAC_INSTALLER_SIGNING_IDENTITY`: exact Keychain common name or
  40-hex SHA-1 fingerprint for the App Store installer certificate/private-key
  identity used by the distribution `.pkg`.

The public version and upload build are separate, source-controlled values in
`package.json`: `version` supplies `CFBundleShortVersionString`, while
`desktopBuild.macBuildNumber` supplies `CFBundleVersion`. The initial 1.2.0
candidate uses build `1.2.0`. Before every upload, confirm that value is greater
than every Mac build already uploaded in App Store Connect; replacement uploads
increment the build number without changing the public version.

Use an Apple Development identity and development provisioning profile only for
local validation. Use Apple Distribution plus the matching distribution profile
for the submission app; the `.pkg` also needs a Mac Installer Distribution
identity (or a still-valid legacy `3rd Party Mac Developer Installer` identity).
The package verifier resolves both selectors to exact Keychain certificates,
binds the configured team to each certificate's subject OU, and requires the
package leaf certificate SHA-256 fingerprint to match that resolved installer
certificate.
The distribution-signed application is not expected to launch directly before
Apple re-signs it through TestFlight or the Mac App Store.
