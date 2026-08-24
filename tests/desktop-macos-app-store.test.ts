import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageRecord = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};

test("Mac App Store scripts use the MAS runtime and exact signing distribution modes", () => {
  assert.equal(packageRecord.devDependencies["@electron-forge/maker-pkg"], "7.11.2");
  assert.equal(packageRecord.devDependencies["@electron/osx-sign"], "1.3.3");
  assert.match(packageRecord.scripts["desktop:mas:package:development:arm64"], /mas-development[\s\S]*--platform=mas --arch=arm64/);
  assert.match(packageRecord.scripts["desktop:mas:make:arm64"], /mas-distribution[\s\S]*--platform=mas --arch=arm64/);
});

test("Mac App Store entitlements are minimal and inherited by child code", () => {
  const main = readFileSync("desktop/mas/entitlements.plist", "utf8");
  const child = readFileSync("desktop/mas/entitlements.inherit.plist", "utf8");
  for (const key of [
    "com.apple.security.app-sandbox",
    "com.apple.security.files.bookmarks.app-scope",
    "com.apple.security.files.user-selected.read-write",
    "com.apple.security.network.client",
    "com.apple.security.network.server",
  ]) assert.match(main, new RegExp(`<key>${key.replaceAll(".", "\\.")}</key>\\s*<true\\s*/>`));
  for (const forbidden of ["camera", "microphone", "usb", "location", "contacts", "calendar", "photos-library", "temporary-exception"]) {
    assert.doesNotMatch(main.toLowerCase(), new RegExp(forbidden));
  }
  assert.match(child, /<key>com\.apple\.security\.app-sandbox<\/key>\s*<true\s*\/>/);
  assert.match(child, /<key>com\.apple\.security\.inherit<\/key>\s*<true\s*\/>/);
});

test("Forge and finalizer keep App Store signing fail-closed and separate from direct distribution", () => {
  const forge = readFileSync("forge.config.cjs", "utf8");
  const prepare = readFileSync("scripts/prepare-desktop.ts", "utf8");
  const finalizer = readFileSync("scripts/finalize-desktop-package.ts", "utf8");
  assert.match(forge, /new MakerPKG/);
  assert.match(forge, /expectedForgePlatform = macAppStoreBuild \? "mas" : targetPlatform/);
  assert.match(forge, /RANGABOT_MAC_TEAM_ID/);
  assert.match(forge, /RANGABOT_MAC_APP_SIGNING_IDENTITY/);
  assert.match(forge, /RANGABOT_MAC_PROVISIONING_PROFILE/);
  assert.match(forge, /RANGABOT_MAC_INSTALLER_SIGNING_IDENTITY/);
  assert.match(prepare, /8037c385407a2efc9b85b0d1b39121735571e0bc6a00eb44d29c1873fbe1a9d3/);
  assert.match(prepare, /a51158c5bb802cd441049fd733bfe803b6b5581f01dd83bbfb5cee07b45626c4/);
  assert.match(finalizer, /platform: "mas"/);
  assert.match(finalizer, /preEmbedProvisioningProfile: true/);
  assert.match(finalizer, /codesign", \["--verify", "--deep", "--strict"/);
  assert.match(finalizer, /Identifier=com\.rangabot\.desktop/);
  assert.match(finalizer, /TeamIdentifier=/);
  assert.match(finalizer, /Authority=/);
});

test("Mac App Store runtime never auto-opens the standard home Ollama model store", () => {
  const main = readFileSync("desktop/electron/main.ts", "utf8");
  assert.match(main, /standardModelsRoot: macAppStore \? undefined : join\(electronApp\.getPath\("home"\), "\.ollama", "models"\)/);
  assert.match(main, /securityScopedBookmarks: macAppStore/);
  assert.match(main, /rememberMacSecurityScopedAccess/);
  assert.match(main, /restoreMacSecurityScopedAccess/);
});
