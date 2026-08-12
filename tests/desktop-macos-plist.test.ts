import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  PROHIBITED_USAGE_DESCRIPTION_KEYS,
  assertMacOSInfoPlistPolicy,
  hardenPackagedMacOSInfoPlist,
  readMacOSInfoPlist,
} = require("../desktop/electron/macos-plist-policy.cjs") as {
  PROHIBITED_USAGE_DESCRIPTION_KEYS: readonly string[];
  assertMacOSInfoPlistPolicy(value: Record<string, unknown>): void;
  hardenPackagedMacOSInfoPlist(outputPath: string): Record<string, unknown>;
  readMacOSInfoPlist(plistPath: string): Record<string, unknown>;
};

const projectRoot = resolve(import.meta.dirname, "..");

test("macOS plist policy rejects inherited broad transport and unused permission declarations", () => {
  assert.deepEqual(PROHIBITED_USAGE_DESCRIPTION_KEYS, [
    "NSAudioCaptureUsageDescription",
    "NSBluetoothAlwaysUsageDescription",
    "NSBluetoothPeripheralUsageDescription",
    "NSCameraUsageDescription",
    "NSMicrophoneUsageDescription",
  ]);
  assert.throws(() => assertMacOSInfoPlistPolicy({
    NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
  }), /NSAllowsArbitraryLoads/);
  for (const key of PROHIBITED_USAGE_DESCRIPTION_KEYS) {
    assert.throws(() => assertMacOSInfoPlistPolicy({ [key]: "unused" }), new RegExp(key));
  }
  assert.doesNotThrow(() => assertMacOSInfoPlistPolicy({
    CFBundleIdentifier: "com.rangabot.desktop",
  }));
});

test("Forge hardens the final plist before artifact finalization", () => {
  const forgeSource = readFileSync(join(projectRoot, "forge.config.cjs"), "utf8");
  const hardeningIndex = forgeSource.indexOf("hardenPackagedMacOSInfoPlist(outputPath)");
  const finalizerIndex = forgeSource.indexOf("scripts\", \"finalize-desktop-package.ts");
  assert.ok(hardeningIndex >= 0, "Forge must invoke final-package plist hardening");
  assert.ok(finalizerIndex > hardeningIndex, "plist hardening must run before artifact finalization");
});

test("final-package plist hardening removes only the inherited broad declarations", {
  skip: process.platform !== "darwin",
}, () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-plist-policy-"));
  try {
    const contents = join(root, "RangaBot.app", "Contents");
    mkdirSync(contents, { recursive: true });
    const plistPath = join(contents, "Info.plist");
    writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.rangabot.desktop</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict>
  <key>NSAudioCaptureUsageDescription</key><string>unused</string>
  <key>NSBluetoothAlwaysUsageDescription</key><string>unused</string>
  <key>NSBluetoothPeripheralUsageDescription</key><string>unused</string>
  <key>NSCameraUsageDescription</key><string>unused</string>
  <key>NSMicrophoneUsageDescription</key><string>unused</string>
</dict></plist>\n`);
    const hardened = hardenPackagedMacOSInfoPlist(root);
    assert.deepEqual(hardened, { CFBundleIdentifier: "com.rangabot.desktop" });
    assert.deepEqual(readMacOSInfoPlist(plistPath), hardened);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
