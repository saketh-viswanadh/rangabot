import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { FuseState, FuseV1Options, FuseVersion, getCurrentFuseWire } from "@electron/fuses";
import {
  DESKTOP_FUSE_POLICY_NAME,
  REQUIRED_DESKTOP_FUSE_NAMES,
  REQUIRED_DESKTOP_FUSE_POLICY,
  REQUIRED_DESKTOP_FUSE_WIRE_STATES,
  collectDesktopArtifactFiles,
  collectDesktopBundleFiles,
  createDesktopArtifactManifest,
  desktopFuseBinaryPath,
  inspectDesktopArtifact,
  parseDesktopArtifactManifest,
  type DesktopArtifactArch,
  type DesktopArtifactFile,
  type DesktopArtifactTarget,
} from "../lib/desktop-artifact-identity.ts";
import { isForbiddenDesktopPrivateResourcePath } from "../lib/desktop-private-payload-policy.ts";

const projectRoot = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { assertWindowsPeCertificateTableAbsent } = require("../desktop/electron/windows-pe-certificate.cjs") as {
  assertWindowsPeCertificateTableAbsent(path: string, label?: string): Readonly<{
    embeddedPeCertificateTable: "absent";
  }>;
};

function parseArguments(arguments_: string[]) {
  const archValues = arguments_.filter((value) => value.startsWith("--arch=")).map((value) => value.slice(7));
  const outputs = arguments_.filter((value) => value.startsWith("--output=")).map((value) => resolve(value.slice(9)));
  const platformValues = arguments_.filter((value) => value.startsWith("--platform=")).map((value) => value.slice(11));
  if (archValues.length !== 1 || (archValues[0] !== "arm64" && archValues[0] !== "x64")
    || platformValues.length !== 1 || (platformValues[0] !== "darwin" && platformValues[0] !== "win32")
    || (platformValues[0] === "win32" && archValues[0] !== "x64")
    || outputs.length === 0 || outputs.length + 2 !== arguments_.length) {
    throw new Error("Usage: finalize-desktop-package.ts --platform=darwin|win32 --arch=arm64|x64 --output=<Forge output> [...]");
  }
  return { target: { platform: platformValues[0], arch: archValues[0] } as DesktopArtifactTarget, outputs };
}

function findApp(output: string, platform: DesktopArtifactTarget["platform"]) {
  const status = lstatSync(output);
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error("Forge output must be a real directory.");
  if (platform === "win32") {
    if (!existsSync(join(output, "RangaBot.exe"))) throw new Error("Forge output is missing RangaBot.exe.");
    return output;
  }
  if (output.endsWith(".app")) return output;
  const apps = readdirSync(output).filter((name) => name.endsWith(".app"));
  if (apps.length !== 1) throw new Error("Forge output must contain exactly one macOS app bundle.");
  return join(output, apps[0]);
}

function manifestRelativePath(artifactRoot: string, manifestPath: string) {
  const path = relative(artifactRoot, manifestPath).split(sep).join("/");
  if (!path || path.startsWith("../") || path.includes("\\")) throw new Error("Desktop manifest escaped the final Resources root.");
  return path;
}

function assertRequiredResources(files: readonly DesktopArtifactFile[], platform: DesktopArtifactTarget["platform"] = "darwin") {
  const paths = new Set(files.map((file) => file.path));
  for (const path of [
    "app.asar",
    "rangabot-resources/server.js",
    "rangabot-resources/.next/BUILD_ID",
    "rangabot-resources/lib/sql-runtime-worker.cjs",
    "rangabot-resources/package.json",
    "rangabot-resources/public/brand/rangabot-primary-64.png",
    "rangabot-resources/public/brand/rangabot-primary-192.png",
    "rangabot-resources/public/brand/rangabot-primary-512.png",
    "rangabot-resources/public/brand/rangabot-chat-mark-light.svg",
    "rangabot-resources/public/brand/rangabot-chat-mark-dark.svg",
    "rangabot-resources/public/brand/rangabot-spark.svg",
    "rangabot-resources/node_modules/next/package.json",
  ]) {
    if (!paths.has(path)) throw new Error(`Final desktop package is missing ${path}.`);
  }
  if (platform === "win32") {
    for (const path of ["rangabot-resources/runtime/ollama/ollama.exe", "rangabot-resources/THIRD_PARTY_NOTICES.md"]) {
      if (!paths.has(path)) throw new Error(`Final Windows desktop package is missing ${path}.`);
    }
  }
  if (![...paths].some((path) => path.startsWith("rangabot-resources/.next/static/"))) {
    throw new Error("Final desktop package is missing Next static assets.");
  }
  const resourcePrefix = "rangabot-resources/";
  const forbidden = [...paths].find((path) => /(^|\/)(?:\.git|\.env(?:\.|$)|tests?)(?:\/|$)/i.test(path)
    || (path.toLowerCase().startsWith(resourcePrefix)
      && isForbiddenDesktopPrivateResourcePath(path.slice(resourcePrefix.length))));
  if (forbidden) throw new Error(`Final desktop package contains forbidden private/developer data: ${forbidden}.`);
}

function assertBrowserSnapshotFuseCompatibility(
  contentsRoot: string,
  fuseState: FuseState,
) {
  const hasBrowserSnapshot = existsSync(join(
    contentsRoot,
    "Frameworks",
    "Electron Framework.framework",
    "Versions",
    "A",
    "Resources",
    "browser_v8_context_snapshot.bin",
  ));
  if (fuseState !== FuseState.DISABLE) {
    throw new Error(`${DESKTOP_FUSE_POLICY_NAME} requires the browser-specific V8 snapshot fuse to remain disabled.`);
  }
  return { required: false, present: hasBrowserSnapshot };
}

function expectedFuseStates() {
  return new Map<number, FuseState>([
    [FuseV1Options.RunAsNode, FuseState.DISABLE],
    [FuseV1Options.EnableCookieEncryption, FuseState.ENABLE],
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
    [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
    [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FuseState.DISABLE],
    [FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE],
    [FuseV1Options.WasmTrapHandlers, FuseState.ENABLE],
  ]);
}

async function assertFuses(executablePath: string, target: DesktopArtifactTarget) {
  const wire = await getCurrentFuseWire(executablePath);
  if (wire.version !== FuseVersion.V1) throw new Error(`${DESKTOP_FUSE_POLICY_NAME} has an unsupported fuse-wire version.`);
  const numericKeys = Object.keys(wire).filter((key) => /^\d+$/.test(key)).map(Number).sort((a, b) => a - b);
  const expected = [...expectedFuseStates().keys()];
  if (numericKeys.length !== expected.length || numericKeys.some((key, index) => key !== expected[index])) {
    throw new Error(`${DESKTOP_FUSE_POLICY_NAME} contains missing or unknown fuses.`);
  }
  for (const [key, state] of expectedFuseStates()) {
    if (wire[key as keyof typeof wire] !== state) {
      throw new Error(`${DESKTOP_FUSE_POLICY_NAME}: Electron fuse ${FuseV1Options[key]} is not in its required state.`);
    }
  }
  const states = numericKeys.map((key) => Number(wire[key as keyof typeof wire]));
  if (states.some((state, index) => state !== REQUIRED_DESKTOP_FUSE_WIRE_STATES[index])) {
    throw new Error(`${DESKTOP_FUSE_POLICY_NAME} named states do not match its required raw wire.`);
  }
  return {
    version: "1" as const,
    states,
    inspection: {
      inspectedPath: desktopFuseBinaryPath(target.platform),
      wireVersion: "1" as const,
      wireLength: 9 as const,
      entries: states.map((actual, index) => ({
        index,
        name: REQUIRED_DESKTOP_FUSE_NAMES[index],
        expected: REQUIRED_DESKTOP_FUSE_WIRE_STATES[index],
        actual,
      })),
    },
  };
}

function assertPeX64(path: string) {
  const descriptor = openSync(path, "r");
  try {
    const header = Buffer.alloc(64);
    if (readSync(descriptor, header, 0, header.length, 0) !== header.length || header.readUInt16LE(0) !== 0x5a4d) {
      throw new Error(`Native payload is not a valid PE file: ${path}.`);
    }
    const peOffset = header.readUInt32LE(0x3c);
    const pe = Buffer.alloc(6);
    if (readSync(descriptor, pe, 0, pe.length, peOffset) !== pe.length
      || pe.readUInt32LE(0) !== 0x00004550 || pe.readUInt16LE(4) !== 0x8664) {
      throw new Error(`Native payload does not provide Windows x64 machine code: ${path}.`);
    }
  } finally {
    closeSync(descriptor);
  }
}

function assertMachOArchitecture(path: string, arch: DesktopArtifactArch) {
  const reported = execFileSync("/usr/bin/lipo", ["-archs", path], { encoding: "utf8" }).trim().split(/\s+/);
  const expected = arch === "x64" ? "x86_64" : "arm64";
  if (!reported.includes(expected)) throw new Error(`Native payload does not contain required ${arch} architecture: ${path}.`);
  if (extname(path) === "" && reported.length !== 1) throw new Error("The packaged Electron executable must be architecture-specific, not universal.");
}

function makeTreeReadOnly(directory: string, resourceRoot = directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const status = lstatSync(path);
    if (status.isSymbolicLink()) throw new Error("Final desktop Resources cannot contain symbolic links.");
    if (status.isDirectory()) {
      makeTreeReadOnly(path, resourceRoot);
      chmodSync(path, 0o555);
    } else if (status.isFile()) {
      const relative = path.slice(resourceRoot.length + 1).replaceAll("\\", "/");
      const managedRuntimeExecutable = /^(?:rangabot-resources\/)?runtime\/ollama\/(?:ollama|llama-server|llama-quantize)$/.test(relative);
      chmodSync(path, managedRuntimeExecutable ? 0o555 : 0o444);
    }
    else throw new Error("Final desktop Resources contains an unsupported filesystem entry.");
  }
}

function writeManifestAtomically(path: string, value: unknown, platform: DesktopArtifactTarget["platform"]) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: platform === "win32" ? 0o600 : 0o444, flag: "wx" });
  renameSync(temporary, path);
  if (platform !== "win32") chmodSync(path, 0o444);
}

function signEntireAppAdHoc(appPath: string) {
  execFileSync("/usr/bin/codesign", [
    "--sign", "-", "--force", "--deep",
    "--preserve-metadata=entitlements,requirements,flags,runtime",
    appPath,
  ], { stdio: "inherit" });
}

function sealOuterAppAdHoc(appPath: string) {
  // Nested executable/native payloads were signed before their exact bytes
  // were inventoried. Re-sign only the outer bundle after writing the final
  // manifest so Contents/_CodeSignature seals that manifest without changing
  // any resource or native payload recorded by it.
  execFileSync("/usr/bin/codesign", [
    "--sign", "-", "--force",
    "--preserve-metadata=entitlements,requirements,flags,runtime",
    appPath,
  ], { stdio: "inherit" });
}

function verifyFinalAdHocSignature(appPath: string) {
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
  const details = spawnSync("/usr/bin/codesign", ["--display", "--verbose=4", appPath], { encoding: "utf8" });
  const output = `${details.stdout ?? ""}\n${details.stderr ?? ""}`;
  if (details.error) throw details.error;
  if (details.status !== 0 || details.signal || !/(?:^|\n)Signature=adhoc(?:\n|$)/.test(output)) {
    throw new Error("The final macOS app does not have a verified ad-hoc signature.");
  }
}

async function finalizeWindows(output: string, target: DesktopArtifactTarget) {
  const appPath = findApp(output, "win32");
  const artifactRoot = join(appPath, "resources");
  const runtimeResourceRoot = join(artifactRoot, "rangabot-resources");
  const manifestPath = join(runtimeResourceRoot, "desktop", "manifest.json");
  const staged = parseDesktopArtifactManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  if (!staged || staged.target.platform !== "win32" || staged.target.arch !== "x64") {
    throw new Error("The staged Windows provenance manifest is missing or mismatched.");
  }
  const relativeManifest = manifestRelativePath(artifactRoot, manifestPath);
  const resources = collectDesktopArtifactFiles(artifactRoot, [relativeManifest]);
  assertRequiredResources(resources, "win32");
  const natives = resources.filter((file) => /\.(?:node|dll|so|dylib|exe)$/i.test(file.path));
  if (natives.some((file) => /\.(?:so|dylib)$/i.test(file.path))) {
    throw new Error("The Windows resource payload contains a foreign native library.");
  }
  const executable = join(appPath, "RangaBot.exe");
  assertPeX64(executable);
  assertWindowsPeCertificateTableAbsent(executable, "Final RangaBot.exe");
  for (const native of natives) assertPeX64(join(artifactRoot, ...native.path.split("/")));
  const wire = await assertFuses(executable, target);
  const bundleFiles = collectDesktopBundleFiles(appPath, "win32");
  for (const file of bundleFiles.filter((entry) => /\.(?:exe|dll)$/i.test(entry.path))) {
    assertPeX64(join(appPath, ...file.path.split("/")));
  }
  const manifest = createDesktopArtifactManifest({
    sourceBaseCommit: staged.sourceBaseCommit,
    sourceBaselineCommit: staged.sourceBaselineCommit,
    sourceCommit: staged.sourceCommit,
    sourceDirty: staged.sourceDirty,
    sourceManifestSha256: staged.sourceManifestSha256,
    sourceFiles: staged.sourceFiles,
    packageLockSha256: staged.packageLockSha256,
    webFeedback: staged.webFeedback,
    launchProfile: staged.launchProfile,
    runtimeVersions: staged.runtimeVersions,
    target,
    fuses: REQUIRED_DESKTOP_FUSE_POLICY,
    packagingTooling: {
      electronForge: staged.packagingTooling.electronForge,
      electronFuses: staged.packagingTooling.electronFuses,
      fuseWireVersion: wire.version,
      fuseWireStates: wire.states,
      fuseInspection: wire.inspection,
      signature: { mode: "unsigned-candidate", postFuseMutation: true, deepStrictVerified: false },
    },
    bundleFiles,
    resources,
    natives,
    generatedAt: new Date().toISOString(),
  });
  writeManifestAtomically(manifestPath, manifest, "win32");
  const verified = inspectDesktopArtifact({
    resourceRoot: artifactRoot,
    manifestPath,
    runtime: {
      platform: "win32",
      arch: "x64",
      electron: manifest.runtimeVersions.electron,
      embeddedNode: manifest.runtimeVersions.embeddedNode,
      next: manifest.runtimeVersions.next,
      nativeModules: manifest.runtimeVersions.nativeModules,
    },
  });
  if (verified.state !== "dirty" || verified.reason !== "distribution-unsigned") {
    throw new Error(`Final unsigned Windows artifact identity failed verification: ${verified.state}/${verified.reason}.`);
  }
  const evidencePath = resolve(projectRoot, "desktop", "out", "desktop-artifact-win32-x64.json");
  writeFileSync(evidencePath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return {
    appPath,
    evidencePath,
    manifest,
    verifiedState: verified.state,
    verificationReason: verified.reason,
    browserSnapshotCompatibility: { required: false, present: false },
  };
}

async function finalize(output: string, target: DesktopArtifactTarget) {
  if (target.platform === "win32") return finalizeWindows(output, target);
  const { arch } = target;
  const appPath = findApp(output, "darwin");
  const contentsRoot = join(appPath, "Contents");
  const artifactRoot = join(contentsRoot, "Resources");
  const runtimeResourceRoot = join(artifactRoot, "rangabot-resources");
  const manifestPath = join(runtimeResourceRoot, "desktop", "manifest.json");
  const staged = parseDesktopArtifactManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  if (!staged || staged.target.platform !== "darwin" || staged.target.arch !== arch) throw new Error("The staged desktop provenance manifest is missing or mismatched.");
  const relativeManifest = manifestRelativePath(artifactRoot, manifestPath);
  const unsignedResources = collectDesktopArtifactFiles(artifactRoot, [relativeManifest]);
  assertRequiredResources(unsignedResources);
  const unsignedNatives = unsignedResources.filter((file) => /\.(?:node|dylib|so|dll|exe)$/i.test(file.path));
  const wire = await assertFuses(appPath, target);
  const browserSnapshotCompatibility = assertBrowserSnapshotFuseCompatibility(
    contentsRoot,
    wire.inspection.entries[FuseV1Options.LoadBrowserProcessSpecificV8Snapshot].actual as FuseState,
  );
  const executable = join(contentsRoot, "MacOS", basename(appPath, ".app"));
  assertMachOArchitecture(executable, arch);
  for (const native of unsignedNatives) assertMachOArchitecture(join(artifactRoot, ...native.path.split("/")), arch);

  // Fuse mutation invalidates the original Mach-O signature. Sign nested code
  // first, then hash the exact post-sign Resources bytes that will be bound by
  // the installed artifact manifest.
  signEntireAppAdHoc(appPath);
  const postMutationWire = await assertFuses(appPath, target);
  if (postMutationWire.states.some((state, index) => state !== wire.states[index])) {
    throw new Error("The initial ad-hoc signature restoration changed the Electron fuse wire.");
  }
  const resources = collectDesktopArtifactFiles(artifactRoot, [relativeManifest]);
  assertRequiredResources(resources);
  const natives = resources.filter((file) => /\.(?:node|dylib|so|dll|exe)$/i.test(file.path));
  const bundleFiles = collectDesktopBundleFiles(contentsRoot, "darwin");
  const manifest = createDesktopArtifactManifest({
    sourceBaseCommit: staged.sourceBaseCommit,
    sourceBaselineCommit: staged.sourceBaselineCommit,
    sourceCommit: staged.sourceCommit,
    sourceDirty: staged.sourceDirty,
    sourceManifestSha256: staged.sourceManifestSha256,
    sourceFiles: staged.sourceFiles,
    packageLockSha256: staged.packageLockSha256,
    webFeedback: staged.webFeedback,
    launchProfile: staged.launchProfile,
    runtimeVersions: staged.runtimeVersions,
    target: staged.target,
    fuses: REQUIRED_DESKTOP_FUSE_POLICY,
    packagingTooling: {
      electronForge: staged.packagingTooling.electronForge,
      electronFuses: staged.packagingTooling.electronFuses,
      fuseWireVersion: postMutationWire.version,
      fuseWireStates: postMutationWire.states,
      fuseInspection: postMutationWire.inspection,
      signature: {
        mode: "adhoc",
        postFuseMutation: true,
        deepStrictVerified: true,
      },
    },
    bundleFiles,
    resources,
    natives,
    generatedAt: new Date().toISOString(),
  });
  writeManifestAtomically(manifestPath, manifest, "darwin");
  makeTreeReadOnly(artifactRoot);

  sealOuterAppAdHoc(appPath);
  verifyFinalAdHocSignature(appPath);
  const signedWire = await assertFuses(appPath, target);
  if (signedWire.states.some((state, index) => state !== postMutationWire.states[index])) {
    throw new Error("The final ad-hoc signature step changed the Electron fuse wire.");
  }
  const signedBundleFiles = collectDesktopBundleFiles(contentsRoot, "darwin");
  if (JSON.stringify(signedBundleFiles) !== JSON.stringify(bundleFiles)) {
    throw new Error("The final outer ad-hoc seal changed an identity-bound bundle file.");
  }

  const verified = inspectDesktopArtifact({
    resourceRoot: artifactRoot,
    manifestPath,
    runtime: {
      platform: "darwin",
      arch,
      electron: manifest.runtimeVersions.electron,
      embeddedNode: manifest.runtimeVersions.embeddedNode,
      next: manifest.runtimeVersions.next,
      nativeModules: manifest.runtimeVersions.nativeModules,
    },
  });
  if (verified.state !== (manifest.sourceDirty ? "dirty" : "known")) {
    throw new Error(`Final desktop artifact identity failed verification: ${verified.state}/${verified.reason}.`);
  }
  const packageVariant = process.env.RANGABOT_DESKTOP_PACKAGE_VARIANT;
  if (packageVariant !== undefined && packageVariant !== "normal-refresh-20260812-v1") {
    throw new Error("The desktop package output variant is not recognized.");
  }
  if (staged.launchProfile.kind === "finder-synthetic-v1" && packageVariant !== undefined) {
    throw new Error("The normal package output variant cannot be combined with a verification profile.");
  }
  const evidenceName = staged.launchProfile.kind === "finder-synthetic-v1"
      ? `desktop-artifact-verification-darwin-${arch}.json`
    : packageVariant === "normal-refresh-20260812-v1"
      ? `desktop-artifact-normal-refresh-20260812-darwin-${arch}.json`
      : `desktop-artifact-darwin-${arch}.json`;
  const evidencePath = resolve(projectRoot, "desktop", "out", evidenceName);
  writeFileSync(evidencePath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { appPath, evidencePath, manifest, verifiedState: verified.state, verificationReason: verified.reason, browserSnapshotCompatibility };
}

const { target, outputs } = parseArguments(process.argv.slice(2));
for (const output of outputs) {
  const result = await finalize(output, target);
  console.log(JSON.stringify({
    appPath: result.appPath,
    evidencePath: result.evidencePath,
    desktopArtifactId: result.manifest.desktopArtifactId,
    sourceBaseCommit: result.manifest.sourceBaseCommit,
    profilesBehaviorCommit: result.manifest.sourceBaselineCommit,
    packagingCommit: result.manifest.sourceCommit,
    fusePolicyName: DESKTOP_FUSE_POLICY_NAME,
    fuseWire: String.fromCharCode(...result.manifest.packagingTooling.fuseWireStates),
    browserSnapshotCompatibility: result.browserSnapshotCompatibility,
    sourceDirty: result.manifest.sourceDirty,
    target: result.manifest.target,
    launchProfile: result.manifest.launchProfile,
    resourceManifestSha256: result.manifest.resourceManifestSha256,
    nativeManifestSha256: result.manifest.nativeManifestSha256,
    bundleManifestSha256: result.manifest.bundleManifestSha256,
    fuseInspection: result.manifest.packagingTooling.fuseInspection,
    resources: result.manifest.resources.length,
    natives: result.manifest.natives.length,
    fuses: result.manifest.fuses,
    packagingTooling: result.manifest.packagingTooling,
    signature: result.manifest.packagingTooling.signature,
    verifiedState: result.verifiedState,
    verificationReason: result.verificationReason,
  }, null, 2));
}
