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
- `RANGABOT_MAC_APP_SIGNING_IDENTITY`: exact Keychain identity for the app.
- `RANGABOT_MAC_PROVISIONING_PROFILE`: absolute path to the matching Mac App
  Store provisioning profile.
- `RANGABOT_MAC_INSTALLER_SIGNING_IDENTITY`: exact installer identity for a
  distribution `.pkg`.

Use an Apple Development identity and development provisioning profile only for
local validation. Use Apple Distribution plus the matching distribution profile
for the submission app; the `.pkg` also needs the App Store installer identity.
The distribution-signed application is not expected to launch directly before
Apple re-signs it through TestFlight or the Mac App Store.
