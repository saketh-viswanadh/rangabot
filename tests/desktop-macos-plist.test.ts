import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  PROHIBITED_USAGE_DESCRIPTION_KEYS,
  assertMacOSBuildNumber,
  assertMacOSInfoPlistPolicy,
  assertMacOSInfoPlistProductVersion,
  assertMacOSMarketingVersion,
  hardenPackagedMacOSInfoPlist,
  readMacOSInfoPlist,
} = require("../desktop/electron/macos-plist-policy.cjs") as {
  PROHIBITED_USAGE_DESCRIPTION_KEYS: readonly string[];
  assertMacOSBuildNumber(value: unknown): void;
  assertMacOSInfoPlistPolicy(value: Record<string, unknown>): void;
  assertMacOSInfoPlistProductVersion(value: Record<string, unknown>, productVersion: string, macBuildNumber: string): void;
  assertMacOSMarketingVersion(value: unknown): void;
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

test("macOS plist keeps the marketing version independent from the bound build number", () => {
  const plist = {
    CFBundleShortVersionString: "1.2.0",
    CFBundleVersion: "1.2.0",
  };
  assert.doesNotThrow(() => assertMacOSInfoPlistProductVersion(plist, "1.2.0", "1.2.0"));
  assert.doesNotThrow(() => assertMacOSInfoPlistProductVersion({ ...plist, CFBundleVersion: "1.2.1" }, "1.2.0", "1.2.1"));
  assert.throws(
    () => assertMacOSInfoPlistProductVersion({ ...plist, CFBundleShortVersionString: "0.1.0" }, "1.2.0", "1.2.0"),
    /CFBundleShortVersionString/,
  );
  assert.throws(
    () => assertMacOSInfoPlistProductVersion({ ...plist, CFBundleVersion: "0.1.0" }, "1.2.0", "1.2.0"),
    /CFBundleVersion/,
  );
  for (const valid of ["1", "1.2", "1.2.0", "9999.99.99"]) {
    assert.doesNotThrow(() => assertMacOSBuildNumber(valid));
  }
  for (const invalid of ["", "0", "0.1", "01", "1.02", "1.2.00", "10000", "1.100", "1.2.3.4", "1.2-beta"]) {
    assert.throws(() => assertMacOSBuildNumber(invalid), /build number/i);
  }
  assert.doesNotThrow(() => assertMacOSMarketingVersion("1.2.0"));
  for (const invalid of ["1", "1.2", "01.2.0", "1.2.0-beta"]) {
    assert.throws(() => assertMacOSMarketingVersion(invalid), /marketing version/i);
  }
});

test("Forge hardens the final plist before artifact finalization", () => {
  const forgeSource = readFileSync(join(projectRoot, "forge.config.cjs"), "utf8");
  const finalizerSource = readFileSync(join(projectRoot, "scripts", "finalize-desktop-package.ts"), "utf8");
  const hardeningIndex = forgeSource.indexOf("hardenPackagedMacOSInfoPlist(outputPath)");
  const finalizerIndex = forgeSource.indexOf("scripts\", \"finalize-desktop-package.ts");
  assert.ok(hardeningIndex >= 0, "Forge must invoke final-package plist hardening");
  assert.ok(finalizerIndex > hardeningIndex, "plist hardening must run before artifact finalization");
  assert.match(forgeSource, /appVersion: productVersion/u);
  assert.match(forgeSource, /buildVersion: macBuildNumber/u);
  assert.match(finalizerSource, /assertMacOSInfoPlistProductVersion\([\s\S]*?staged\.productVersion,[\s\S]*?staged\.macBuildNumber/u);
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
