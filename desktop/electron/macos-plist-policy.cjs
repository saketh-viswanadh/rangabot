"use strict";

const { execFileSync } = require("node:child_process");
const { existsSync, readdirSync, statSync } = require("node:fs");
const path = require("node:path");

const PROHIBITED_USAGE_DESCRIPTION_KEYS = Object.freeze([
  "NSAudioCaptureUsageDescription",
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription",
]);
const MAC_BUILD_NUMBER_PATTERN = /^[1-9]\d{0,3}(?:\.(?:0|[1-9]\d?)){0,2}$/u;
const MAC_MARKETING_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

function readMacOSInfoPlist(plistPath) {
  const output = execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const parsed = JSON.parse(output);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The packaged macOS Info.plist is not a dictionary.");
  }
  return parsed;
}

function assertMacOSInfoPlistPolicy(plist) {
  for (const key of PROHIBITED_USAGE_DESCRIPTION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(plist, key)) {
      throw new Error(`Packaged macOS Info.plist must not declare ${key}.`);
    }
  }
  const transportSecurity = plist.NSAppTransportSecurity;
  if (transportSecurity && typeof transportSecurity === "object"
    && !Array.isArray(transportSecurity)
    && Object.prototype.hasOwnProperty.call(transportSecurity, "NSAllowsArbitraryLoads")) {
    throw new Error("Packaged macOS Info.plist must not declare NSAllowsArbitraryLoads.");
  }
}

function assertMacOSBuildNumber(macBuildNumber) {
  if (typeof macBuildNumber !== "string" || !MAC_BUILD_NUMBER_PATTERN.test(macBuildNumber)) {
    throw new Error("The expected macOS build number must use one to three bounded numeric components and begin above zero.");
  }
}

function assertMacOSMarketingVersion(productVersion) {
  if (typeof productVersion !== "string" || !MAC_MARKETING_VERSION_PATTERN.test(productVersion)) {
    throw new Error("The expected macOS marketing version must use three numeric components.");
  }
}

function assertMacOSInfoPlistProductVersion(plist, productVersion, macBuildNumber) {
  assertMacOSMarketingVersion(productVersion);
  assertMacOSBuildNumber(macBuildNumber);
  if (plist.CFBundleShortVersionString !== productVersion) {
    throw new Error("Packaged macOS CFBundleShortVersionString does not match the desktop product version.");
  }
  if (plist.CFBundleVersion !== macBuildNumber) {
    throw new Error("Packaged macOS CFBundleVersion does not match the bound Mac build number.");
  }
}

function removePlistKey(plistPath, key) {
  execFileSync("/usr/bin/plutil", ["-remove", key, plistPath], { stdio: "pipe" });
}

function hardenMacOSInfoPlist(plistPath) {
  if (process.platform !== "darwin") throw new Error("macOS plist hardening can run only on macOS.");
  const before = readMacOSInfoPlist(plistPath);
  for (const key of PROHIBITED_USAGE_DESCRIPTION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(before, key)) removePlistKey(plistPath, key);
  }
  const transportSecurity = before.NSAppTransportSecurity;
  if (transportSecurity && typeof transportSecurity === "object"
    && !Array.isArray(transportSecurity)
    && Object.prototype.hasOwnProperty.call(transportSecurity, "NSAllowsArbitraryLoads")) {
    removePlistKey(plistPath, "NSAppTransportSecurity.NSAllowsArbitraryLoads");
    const afterNestedRemoval = readMacOSInfoPlist(plistPath);
    const remainingTransportSecurity = afterNestedRemoval.NSAppTransportSecurity;
    if (remainingTransportSecurity && typeof remainingTransportSecurity === "object"
      && !Array.isArray(remainingTransportSecurity)
      && Object.keys(remainingTransportSecurity).length === 0) {
      removePlistKey(plistPath, "NSAppTransportSecurity");
    }
  }
  const hardened = readMacOSInfoPlist(plistPath);
  assertMacOSInfoPlistPolicy(hardened);
  return hardened;
}

function packagedInfoPlistPath(outputPath) {
  const resolvedOutput = path.resolve(outputPath);
  const candidates = resolvedOutput.endsWith(".app")
    ? [resolvedOutput]
    : existsSync(resolvedOutput) && statSync(resolvedOutput).isDirectory()
      ? readdirSync(resolvedOutput).filter((entry) => entry.endsWith(".app")).map((entry) => path.join(resolvedOutput, entry))
      : [];
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one packaged macOS application; found ${candidates.map((entry) => path.basename(entry)).join(", ") || "none"}.`);
  }
  const appPath = candidates[0];
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  if (!existsSync(plistPath) || !statSync(plistPath).isFile()) {
    throw new Error("The packaged macOS application is missing a regular Info.plist.");
  }
  return plistPath;
}

function hardenPackagedMacOSInfoPlist(outputPath) {
  return hardenMacOSInfoPlist(packagedInfoPlistPath(outputPath));
}

module.exports = {
  MAC_BUILD_NUMBER_PATTERN,
  MAC_MARKETING_VERSION_PATTERN,
  PROHIBITED_USAGE_DESCRIPTION_KEYS,
  assertMacOSBuildNumber,
  assertMacOSMarketingVersion,
  assertMacOSInfoPlistPolicy,
  assertMacOSInfoPlistProductVersion,
  hardenMacOSInfoPlist,
  hardenPackagedMacOSInfoPlist,
  packagedInfoPlistPath,
  readMacOSInfoPlist,
};
