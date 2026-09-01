# App Store Connect draft

This is metadata preparation, not a published listing.

- **Name:** RangaBot
- **Subtitle:** Private local AI on your Mac
- **Bundle ID:** `com.rangabot.desktop`
- **Version:** `1.2.0`
- **Initial build:** `1.2.0` (must be confirmed above the highest prior Mac
  build before upload)
- **SKU:** `rangabot-macos-001`
- **Primary category:** Productivity
- **Price:** Free
- **Copyright:** use the enrolled individual's current legal-name notice
- **Privacy policy URL:** `https://rangabot.com/privacy`
- **Support URL:** HOLD until a live support destination is verified

## Description draft

RangaBot is a local-first AI workspace for private conversation, learning,
coding, document creation, and analysis on your Mac. It runs open local models
through a managed on-device runtime, keeps chats and settings on your computer,
and accesses documents or datasets only after you choose them.

Capabilities depend on the model and hardware you select. RangaBot exposes
calculation traces and honest capability limits instead of presenting every
generated answer as verified. No mandatory cloud account or paid API is
required for the local workflow.

## Review-note draft

RangaBot bundles a signed local Ollama helper and starts it only for the running
app. Both the application server and model server bind to loopback. Owned child
processes are stopped when RangaBot quits. Model weights are downloaded as user
data into the application's sandbox container. The app does not silently read a
system Ollama model directory.

The network client/server entitlements support the loopback application and
model endpoints plus user-requested model downloads. User-selected read/write
and app-scoped bookmark entitlements support documents, datasets, repositories,
and explicit export destinations. No broad filesystem entitlement is present.

Provide Apple Review with a precise first-run procedure and suitable local model
only after that exact TestFlight build passes the clean-machine acceptance
matrix.
