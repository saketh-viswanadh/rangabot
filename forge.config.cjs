const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { MakerDMG } = require("@electron-forge/maker-dmg");
const { MakerSquirrel } = require("@electron-forge/maker-squirrel");
const { MakerZIP } = require("@electron-forge/maker-zip");
const { flipFuses, getCurrentFuseWire, FuseVersion, FuseV1Options } = require("@electron/fuses");
const { hardenPackagedMacOSInfoPlist } = require("./desktop/electron/macos-plist-policy.cjs");

const FUSE_POLICY_NAME = "electron-43-hardened-v2";

const targetPlatform = process.env.RANGABOT_DESKTOP_TARGET_PLATFORM;
if (targetPlatform !== "darwin" && targetPlatform !== "win32") {
  throw new Error("RANGABOT_DESKTOP_TARGET_PLATFORM must be exactly darwin or win32.");
}

const targetArch = process.env.RANGABOT_DESKTOP_TARGET_ARCH;
if (targetArch !== "arm64" && targetArch !== "x64") {
  throw new Error("RANGABOT_DESKTOP_TARGET_ARCH must be exactly arm64 or x64.");
}
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

function windowsSignTool() {
  const programFiles = process.env["ProgramFiles(x86)"];
  if (!programFiles) throw new Error("Windows SDK discovery requires ProgramFiles(x86).");
  const binRoot = path.join(programFiles, "Windows Kits", "10", "bin");
  const versions = fs.readdirSync(binRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^10\.\d+(?:\.\d+){2}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, "en", { numeric: true }));
  const selected = versions.map((version) => path.join(binRoot, version, "x64", "signtool.exe"))
    .find((candidate) => fs.existsSync(candidate));
  if (!selected) throw new Error("A Windows 10/11 SDK x64 SignTool is required to remove Electron's invalidated signature.");
  return selected;
}

function numericFuseStates(wire) {
  return Object.keys(wire).filter((key) => /^\d+$/.test(key)).map(Number).sort((left, right) => left - right)
    .map((key) => Number(wire[key]));
}

function windowsAuthenticodeStatus(executable) {
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "(Get-AuthenticodeSignature -LiteralPath $env:RANGABOT_SIGNATURE_PATH).Status.ToString()"], {
    encoding: "utf8",
    env: { ...process.env, RANGABOT_SIGNATURE_PATH: executable },
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.error) throw result.error;
  if (result.signal || result.status !== 0) throw new Error("Windows Authenticode inspection failed.");
  return result.stdout.trim();
}

async function normalizeWindowsUnsignedExecutable(executable) {
  const status = windowsAuthenticodeStatus(executable);
  if (status === "NotSigned") return;
  if (status !== "HashMismatch") {
    throw new Error(`RangaBot.exe must be exactly Authenticode NotSigned after fuse mutation; found ${status || "unavailable"}.`);
  }
  const before = numericFuseStates(await getCurrentFuseWire(executable));
  const result = spawnSync(windowsSignTool(), ["remove", "/s", "/q", executable], {
    stdio: "inherit",
    windowsHide: true,
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.signal) throw new Error("Windows SDK SignTool failed to remove the invalidated Electron signature.");
  const after = numericFuseStates(await getCurrentFuseWire(executable));
  if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error("Authenticode removal changed the Electron fuse wire.");
  const normalizedStatus = windowsAuthenticodeStatus(executable);
  if (normalizedStatus !== "NotSigned") {
    throw new Error(`RangaBot.exe must be exactly Authenticode NotSigned after signature normalization; found ${normalizedStatus || "unavailable"}.`);
  }
}

function runFinalizer(packageResult) {
  if (packageResult.platform === "darwin") {
    for (const outputPath of packageResult.outputPaths) hardenPackagedMacOSInfoPlist(outputPath);
  }
  const result = spawnSync(process.execPath, [
    "--experimental-strip-types",
    path.resolve(__dirname, "scripts", "finalize-desktop-package.ts"),
    `--arch=${packageResult.arch}`,
    `--platform=${packageResult.platform}`,
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
      await normalizeWindowsUnsignedExecutable(executable);
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
      if (platform !== targetPlatform || arch !== targetArch) {
        throw new Error(`${FUSE_POLICY_NAME}: desktop fuse target does not match the prepared platform/architecture.`);
      }
      if (platform === "darwin") {
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
    new MakerZIP({}, ["darwin"]),
    new MakerDMG({ format: "ULFO" }, ["darwin"]),
    new MakerZIP({}, ["win32"]),
    new MakerSquirrel({
      name: "RangaBot",
      authors: "RangaBot contributors",
      description: "Local-first personal intelligence on your own machine.",
      setupExe: "RangaBot-win32-x64-Setup.exe",
      setupIcon: path.resolve(__dirname, "desktop", "assets", "rangabot.ico"),
      noMsi: true,
    }, ["win32"]),
  ],
  plugins: [],
};
