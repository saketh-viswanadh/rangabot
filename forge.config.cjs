const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { MakerDMG } = require("@electron-forge/maker-dmg");
const { MakerPKG } = require("@electron-forge/maker-pkg");
const { MakerZIP } = require("@electron-forge/maker-zip");
const { flipFuses, FuseVersion, FuseV1Options } = require("@electron/fuses");
const { hardenPackagedMacOSInfoPlist } = require("./desktop/electron/macos-plist-policy.cjs");
const { assertWindowsPeCertificateTableAbsent } = require("./desktop/electron/windows-pe-certificate.cjs");

const FUSE_POLICY_NAME = "electron-43-hardened-v2";

const targetPlatform = process.env.RANGABOT_DESKTOP_TARGET_PLATFORM;
if (targetPlatform !== "darwin" && targetPlatform !== "win32") {
  throw new Error("RANGABOT_DESKTOP_TARGET_PLATFORM must be exactly darwin or win32.");
}

const targetArch = process.env.RANGABOT_DESKTOP_TARGET_ARCH;
if (targetArch !== "arm64" && targetArch !== "x64") {
  throw new Error("RANGABOT_DESKTOP_TARGET_ARCH must be exactly arm64 or x64.");
}
const desktopDistribution = process.env.RANGABOT_DESKTOP_DISTRIBUTION;
if (desktopDistribution !== undefined
  && desktopDistribution !== "mas-development"
  && desktopDistribution !== "mas-distribution") {
  throw new Error("RANGABOT_DESKTOP_DISTRIBUTION is not recognized.");
}
const macAppStoreBuild = desktopDistribution?.startsWith("mas-") === true;
if (macAppStoreBuild && targetPlatform !== "darwin") {
  throw new Error("The Mac App Store distribution is macOS-only.");
}
function requiredMacAppStoreValue(name, pattern) {
  const value = process.env[name];
  if (!value || value.includes(String.fromCharCode(0)) || !pattern.test(value)) {
    throw new Error(`${name} is required and invalid for the Mac App Store build.`);
  }
  return value;
}
const macTeamId = macAppStoreBuild
  ? requiredMacAppStoreValue("RANGABOT_MAC_TEAM_ID", /^[A-Z0-9]{10}$/)
  : undefined;
const macAppSigningIdentity = macAppStoreBuild
  ? requiredMacAppStoreValue("RANGABOT_MAC_APP_SIGNING_IDENTITY", /^[^\r\n]{3,256}$/)
  : undefined;
const macProvisioningProfile = macAppStoreBuild
  ? requiredMacAppStoreValue("RANGABOT_MAC_PROVISIONING_PROFILE", /^\/[^\r\n]{1,2047}$/)
  : undefined;
const macInstallerSigningIdentity = desktopDistribution === "mas-distribution"
  ? requiredMacAppStoreValue("RANGABOT_MAC_INSTALLER_SIGNING_IDENTITY", /^[^\r\n]{3,256}$/)
  : undefined;
const buildProfile = process.env.RANGABOT_DESKTOP_BUILD_PROFILE;
if (buildProfile !== undefined && buildProfile !== "finder-synthetic-v1") {
  throw new Error("RANGABOT_DESKTOP_BUILD_PROFILE is not recognized.");
}
const verificationBuild = buildProfile === "finder-synthetic-v1";
const packageVariant = process.env.RANGABOT_DESKTOP_PACKAGE_VARIANT;
if (packageVariant !== undefined && packageVariant !== "normal-refresh-20260812-v1") {
  throw new Error("RANGABOT_DESKTOP_PACKAGE_VARIANT is not recognized.");
}
if (verificationBuild && packageVariant !== undefined) {
  throw new Error("The normal package output variant cannot be combined with a verification profile.");
}
const refreshedNormalBuild = packageVariant === "normal-refresh-20260812-v1";
if (verificationBuild && targetArch !== "arm64") {
  throw new Error("The Finder verification artifact is currently bound to arm64 only.");
}
if (verificationBuild && targetPlatform !== "darwin") {
  throw new Error("The Finder verification artifact is macOS-only.");
}
if (verificationBuild && macAppStoreBuild) {
  throw new Error("The Finder verification profile cannot be packaged as a Mac App Store build.");
}
if (targetPlatform === "win32" && targetArch !== "x64") {
  throw new Error("The Windows desktop candidate is currently x64-only.");
}
const appName = verificationBuild ? "RangaBot Verification" : "RangaBot";
const appBundleId = verificationBuild ? "com.rangabot.desktop.verification" : "com.rangabot.desktop";
const stagedResourceParent = path.resolve(__dirname, "desktop", "out", verificationBuild ? "packaged-resources-verification" : "packaged-resources", targetPlatform, targetArch);
const fuseConfiguration = {
  version: FuseVersion.V1,
  strictlyRequireAllFuses: true,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  // Electron's stock macOS archive contains only the standard V8 snapshot.
  // Enabling this optional fuse without browser_v8_context_snapshot.bin makes
  // Electron trap before the JavaScript entrypoint can run.
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  [FuseV1Options.WasmTrapHandlers]: true,
};

function electronExecutableFromBuildPath(buildPath) {
  return path.resolve(buildPath, "..", "..", "MacOS", "Electron");
}

function runFinalizer(packageResult) {
  if (packageResult.platform === "darwin" || packageResult.platform === "mas") {
    for (const outputPath of packageResult.outputPaths) hardenPackagedMacOSInfoPlist(outputPath);
  }
  const identityPlatform = packageResult.platform === "mas" ? "darwin" : packageResult.platform;
  const result = spawnSync(process.execPath, [
    "--experimental-strip-types",
    path.resolve(__dirname, "scripts", "finalize-desktop-package.ts"),
    `--arch=${packageResult.arch}`,
    `--platform=${identityPlatform}`,
    ...packageResult.outputPaths.map((outputPath) => `--output=${outputPath}`),
  ], { cwd: __dirname, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.signal) throw new Error("Desktop package finalization failed.");
}

async function finalizePackagedExecutables(packageResult) {
  if (packageResult.platform === "win32") {
    for (const outputPath of packageResult.outputPaths) {
      const executable = path.resolve(outputPath, "RangaBot.exe");
      if (!fs.existsSync(executable)) throw new Error("Final Windows package is missing RangaBot.exe before fuse mutation.");
      await flipFuses(executable, { ...fuseConfiguration, resetAdHocDarwinSignature: false });
      assertWindowsPeCertificateTableAbsent(executable, "Fuse-mutated RangaBot.exe");
    }
  }
  runFinalizer(packageResult);
}

module.exports = {
  ...(refreshedNormalBuild
    ? { outDir: path.resolve(__dirname, "desktop", "out", "normal-candidate-20260812") }
    : {}),
  packagerConfig: {
    name: appName,
    executableName: appName,
    appBundleId,
    ...(macAppStoreBuild ? { extendInfo: { ElectronTeamID: macTeamId } } : {}),
    appCategoryType: "public.app-category.productivity",
    icon: path.resolve(__dirname, "desktop", "assets", targetPlatform === "darwin" ? "rangabot.icns" : "rangabot.ico"),
    electronZipDir: path.resolve(__dirname, "desktop", "out", "electron-zips"),
    asar: true,
    extraResource: [path.join(stagedResourceParent, "rangabot-resources")],
    // The Electron archive contains only the narrow main-process shell. The
    // complete Next runtime is a separately hashed, read-only extra resource.
    ignore: [/^\/(?!(?:desktop(?:$|\/out(?:$|\/electron-app(?:$|\/)))|package\.json$)).*/],
  },
  hooks: {
    packageAfterCopy: async (_config, buildPath, _electronVersion, platform, arch) => {
      const expectedForgePlatform = macAppStoreBuild ? "mas" : targetPlatform;
      if (platform !== expectedForgePlatform || arch !== targetArch) {
        throw new Error(`${FUSE_POLICY_NAME}: desktop fuse target does not match the prepared platform/architecture.`);
      }
      if (platform === "darwin" || platform === "mas") {
        await flipFuses(electronExecutableFromBuildPath(buildPath), {
          ...fuseConfiguration,
          resetAdHocDarwinSignature: arch === "arm64",
        });
      }
    },
    postPackage: async (_config, packageResult) => finalizePackagedExecutables(packageResult),
  },
  rebuildConfig: {},
  makers: [
    ...(macAppStoreBuild
      ? [new MakerPKG({
          name: `RangaBot-${require("./package.json").version}-${targetArch}-Mac-App-Store`,
          identity: macInstallerSigningIdentity,
        }, ["mas"])]
      : [
          new MakerZIP({}, ["darwin"]),
          new MakerDMG({ format: "ULFO" }, ["darwin"]),
          new MakerZIP({}, ["win32"]),
        ]),
  ],
  plugins: [],
};
