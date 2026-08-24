import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  DESKTOP_SOURCE_BASE_COMMIT,
  DESKTOP_SOURCE_BASELINE_COMMIT,
  REQUIRED_DESKTOP_FUSE_NAMES,
  REQUIRED_DESKTOP_FUSE_POLICY,
  REQUIRED_DESKTOP_FUSE_WIRE_STATES,
  collectDesktopArtifactFiles,
  createDesktopArtifactManifest,
  desktopFuseBinaryPath,
  deriveDesktopSourceManifestSha256,
  type DesktopArtifactFile,
  type DesktopArtifactTarget,
  type DesktopNativeModuleVersion,
  type DesktopWebFeedbackIdentity,
} from "../lib/desktop-artifact-identity.ts";
import { isForbiddenDesktopPrivateResourcePath } from "../lib/desktop-private-payload-policy.ts";
import {
  desktopLaunchProfileForBuild,
  DESKTOP_FINDER_VERIFICATION_BUILD_PROFILE,
} from "../lib/desktop-launch-profile.ts";
import { collectResponseFeedbackCandidateFiles } from "../lib/response-feedback-candidate.ts";
import { createDesktopDependencyNotice } from "../lib/desktop-legal-notices.ts";
import {
  auditOllamaArm64RuntimePayload,
  inspectOllamaRuntimeLegalNotice,
} from "../lib/ollama-runtime-legal.ts";

const projectRoot = resolve(import.meta.dirname, "..");
const outputRoot = resolve(projectRoot, "desktop", "out");
const desktopSourceFiles = [".gitignore", "forge.config.cjs", "next.config.ts", "package.json", "package-lock.json"];
const requiredResourcePaths = [
  "server.js",
  ".next/BUILD_ID",
  ".next/static",
  "public",
  "lib/sql-runtime-worker.cjs",
  "package.json",
  "node_modules/next/package.json",
];
const WEB_FEEDBACK_ARTIFACT_SHA256 = "37810169b1784d08886840fdfb454175a1255db0ce797594970c1f9cb8781525";
const NORMAL_REFRESH_PACKAGE_VARIANT = "normal-refresh-20260812-v1";
const OLLAMA_RUNTIME_VERSION = "0.32.9";
const OLLAMA_RUNTIME_SHA256 = Object.freeze({
  darwin: "17a5b096d4515d00a6415012db847a2b353b389ed7ab33d025e3b98c2f05b49c",
  win32: "7b4f6ce09c1f2c3b21561b323779beaf3ca3c7012f8e4522605a13cbbb19f0b8",
});
const ELECTRON_WINDOWS_X64_SHA256 = "ef0709cfa719739acce73de6f9b684304baf38c6454376638a70d34a7cecffe0";
const ELECTRON_MAS_ARM64_SHA256 = "8037c385407a2efc9b85b0d1b39121735571e0bc6a00eb44d29c1873fbe1a9d3";
const ELECTRON_LICENSE_PAYLOAD = Object.freeze({
  sourceName: "LICENSE",
  destinationName: "ELECTRON_LICENSE",
  bytes: 1_096,
  sha256: "5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d",
});
const ELECTRON_LEGAL_PAYLOAD = Object.freeze({
  darwin: Object.freeze([
    ELECTRON_LICENSE_PAYLOAD,
    Object.freeze({
      sourceName: "LICENSES.chromium.html",
      destinationName: "ELECTRON_CHROMIUM_LICENSES.html",
      bytes: 19_956_019,
      sha256: "4fc0507a046b9ecd0738b2dd64119b5ec8bc29ac0221b63edb693fd5fd497c87",
    }),
  ]),
  win32: Object.freeze([
    ELECTRON_LICENSE_PAYLOAD,
    Object.freeze({
      sourceName: "LICENSES.chromium.html",
      destinationName: "ELECTRON_CHROMIUM_LICENSES.html",
      bytes: 20_313_957,
      sha256: "b911161e6594ec76b872498b423c54406168f2974e0d407a847f7de1e5ff94dd",
    }),
  ]),
});

function parseTarget(arguments_: string[]): DesktopArtifactTarget {
  const values = arguments_.filter((argument) => argument.startsWith("--arch=")).map((argument) => argument.slice(7));
  const platforms = arguments_.filter((argument) => argument.startsWith("--platform=")).map((argument) => argument.slice(11));
  if (values.length !== 1 || platforms.length !== 1 || !["arm64", "x64"].includes(values[0])
    || !["darwin", "win32"].includes(platforms[0]) || arguments_.length !== 2
    || (platforms[0] === "darwin" && values[0] !== "arm64")
    || (platforms[0] === "win32" && values[0] !== "x64")) {
    throw new Error("Desktop preparation supports exactly macOS arm64 or Windows x64.");
  }
  return { platform: platforms[0], arch: values[0] } as DesktopArtifactTarget;
}

function sha256File(path: string) {
  const output = process.platform === "win32"
    ? execFileSync("certutil.exe", ["-hashfile", path, "SHA256"], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })
    : execFileSync("/usr/bin/shasum", ["-a", "256", path], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  const digest = output.match(/\b[0-9a-fA-F]{64}\b/)?.[0]?.toLowerCase();
  if (!digest) throw new Error(`Could not compute SHA-256 for ${relative(projectRoot, path)}.`);
  return digest;
}

function sourceDirty() {
  const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return status.trim().length > 0;
}

function assertBaseline() {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
  const parent = execFileSync("git", ["rev-parse", "HEAD^"], { cwd: projectRoot, encoding: "utf8" }).trim();
  if (head !== DESKTOP_SOURCE_BASELINE_COMMIT && parent !== DESKTOP_SOURCE_BASELINE_COMMIT) {
    throw new Error(`Desktop packaging must start from ${DESKTOP_SOURCE_BASELINE_COMMIT}; found ${head || "unknown"}.`);
  }
}

function sourceCommits() {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
  const base = execFileSync("git", ["merge-base", "HEAD", DESKTOP_SOURCE_BASE_COMMIT], {
    cwd: projectRoot,
    encoding: "utf8",
  }).trim();
  if (base !== DESKTOP_SOURCE_BASE_COMMIT) {
    throw new Error("Desktop packaging source is not descended from the approved Profiles v1 base.");
  }
  return { base, head };
}

function packageVersion(name: string) {
  const path = resolve(projectRoot, "node_modules", ...name.split("/"), "package.json");
  const record = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown; version?: unknown };
  if (record.name !== name || typeof record.version !== "string") throw new Error(`Missing exact package metadata for ${name}.`);
  return record.version;
}

function productIdentity() {
  const record = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8")) as {
    name?: unknown;
    version?: unknown;
    desktopBuild?: { macBuildNumber?: unknown };
  };
  if (record.name !== "rangabot" || typeof record.version !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(record.version)) {
    throw new Error("The desktop product version in package.json is invalid.");
  }
  const macBuildNumber = record.desktopBuild?.macBuildNumber;
  if (typeof macBuildNumber !== "string"
    || !/^[1-9]\d{0,3}(?:\.(?:0|[1-9]\d?)){0,2}$/u.test(macBuildNumber)) {
    throw new Error("The Mac build number in package.json is invalid.");
  }
  return Object.freeze({ productVersion: record.version, macBuildNumber });
}

function copyDirectory(source: string, destination: string) {
  if (!existsSync(source) || !lstatSync(source).isDirectory()) throw new Error(`Required desktop resource is missing: ${relative(projectRoot, source)}.`);
  cpSync(source, destination, { recursive: true, dereference: true, preserveTimestamps: false });
}

function copyFile(source: string, destination: string) {
  if (!existsSync(source) || !lstatSync(source).isFile()) throw new Error(`Required desktop resource is missing: ${relative(projectRoot, source)}.`);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { dereference: true, preserveTimestamps: false });
}

function stageManagedModelRuntime(target: DesktopArtifactTarget, resourceRoot: string) {
  if (target.platform === "darwin" && target.arch !== "arm64") {
    throw new Error("Desktop preparation supports exactly macOS arm64 or Windows x64.");
  }
  const cacheRoot = resolve(outputRoot, "runtime-cache");
  const archiveName = target.platform === "darwin"
    ? `ollama-darwin-v${OLLAMA_RUNTIME_VERSION}.tgz`
    : `ollama-windows-amd64-v${OLLAMA_RUNTIME_VERSION}.zip`;
  const archive = resolve(cacheRoot, archiveName);
  mkdirSync(cacheRoot, { recursive: true, mode: 0o755 });
  if (!existsSync(archive) || sha256File(archive) !== OLLAMA_RUNTIME_SHA256[target.platform]) {
    rmSync(archive, { force: true });
    const asset = target.platform === "darwin" ? "ollama-darwin.tgz" : "ollama-windows-amd64.zip";
    execFileSync(target.platform === "darwin" ? "/usr/bin/curl" : "curl.exe", [
      "--fail", "--location", "--show-error", "--output", archive,
      `https://github.com/ollama/ollama/releases/download/v${OLLAMA_RUNTIME_VERSION}/${asset}`,
    ], { stdio: "inherit" });
  }
  if (sha256File(archive) !== OLLAMA_RUNTIME_SHA256[target.platform]) throw new Error("The managed Ollama runtime checksum is invalid.");
  const destination = resolve(resourceRoot, "runtime", "ollama");
  mkdirSync(destination, { recursive: true, mode: 0o755 });
  execFileSync(target.platform === "darwin" ? "/usr/bin/tar" : "tar.exe", [
    target.platform === "darwin" ? "-xzf" : "-xf", archive, "-C", destination,
  ], { stdio: "inherit" });
  if (target.platform === "win32") {
    const executable = resolve(destination, "ollama.exe");
    if (!existsSync(executable) || !lstatSync(executable).isFile()) throw new Error("The Windows Ollama runtime has no ollama.exe.");
    for (const forbidden of [resolve(destination, "models"), resolve(destination, ".ollama")]) {
      if (existsSync(forbidden)) throw new Error("The managed runtime archive unexpectedly contains model storage.");
    }
    return;
  }
  const thinMachO = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = resolve(directory, name);
      const status = lstatSync(path);
      if (status.isDirectory()) thinMachO(path);
      else if (status.isFile()) {
        const probe = spawnSync("/usr/bin/lipo", [path, "-verify_arch", target.arch]);
        if (probe.status !== 0) {
          if (/\.(?:dylib|so)$/i.test(path)) rmSync(path);
          continue;
        }
        const architectures = execFileSync("/usr/bin/lipo", ["-archs", path], { encoding: "utf8" }).trim().split(/\s+/);
        if (architectures.length === 1 && architectures[0] === target.arch) continue;
        const thinned = `${path}.thin`;
        execFileSync("/usr/bin/lipo", [path, "-thin", target.arch, "-output", thinned]);
        rmSync(path);
        execFileSync("/bin/mv", [thinned, path]);
      }
    }
  };
  thinMachO(destination);
  const removeDanglingLinks = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = resolve(directory, name);
      const status = lstatSync(path);
      if (status.isSymbolicLink()) {
        try { realpathSync(path); } catch { rmSync(path); }
      } else if (status.isDirectory()) removeDanglingLinks(path);
    }
  };
  removeDanglingLinks(destination);
  chmodSync(resolve(destination, "ollama"), 0o755);
}

function stageDesktopLegalPayload(
  resourceRoot: string,
  target: DesktopArtifactTarget,
  includeManagedRuntime: boolean,
) {
  copyFile(resolve(projectRoot, "LICENSE"), resolve(resourceRoot, "LICENSE"));
  copyFile(resolve(projectRoot, "THIRD_PARTY_NOTICES.md"), resolve(resourceRoot, "THIRD_PARTY_NOTICES.md"));
  const electron = ELECTRON_LEGAL_PAYLOAD[target.platform].map((entry) => {
    const source = resolve(projectRoot, "node_modules", "electron", "dist", entry.sourceName);
    const sourceStatus = lstatSync(source);
    if (sourceStatus.isSymbolicLink() || !sourceStatus.isFile() || sourceStatus.nlink !== 1
      || realpathSync(source) !== source || sourceStatus.size !== entry.bytes || sha256File(source) !== entry.sha256) {
      throw new Error(`The pinned Electron ${entry.sourceName} legal payload is missing or changed.`);
    }
    const destination = resolve(resourceRoot, entry.destinationName);
    copyFile(source, destination);
    const destinationStatus = lstatSync(destination);
    if (!destinationStatus.isFile() || destinationStatus.isSymbolicLink()
      || destinationStatus.size !== entry.bytes || sha256File(destination) !== entry.sha256) {
      throw new Error(`The staged Electron ${entry.sourceName} legal payload changed during copy.`);
    }
    return Object.freeze({ path: entry.destinationName, bytes: entry.bytes, sha256: entry.sha256 });
  });
  const dependencyNotice = createDesktopDependencyNotice({ projectRoot, resourceRoot });
  writeFileSync(resolve(resourceRoot, "DEPENDENCY_NOTICES.md"), dependencyNotice.notice, {
    encoding: "utf8",
    mode: 0o444,
    flag: "wx",
  });
  let ollamaRuntimeNotice = null;
  if (includeManagedRuntime && target.platform === "darwin") {
    if (target.arch !== "arm64") {
      throw new Error("The managed macOS x64 Ollama runtime has no reviewed target-specific legal inventory.");
    }
    const source = resolve(projectRoot, "desktop", "legal", "OLLAMA_RUNTIME_NOTICES.md");
    const reviewed = inspectOllamaRuntimeLegalNotice(source);
    const destination = resolve(resourceRoot, "OLLAMA_RUNTIME_NOTICES.md");
    copyFile(source, destination);
    const staged = inspectOllamaRuntimeLegalNotice(destination);
    if (JSON.stringify(staged) !== JSON.stringify(reviewed)) {
      throw new Error("The staged Ollama runtime legal notice changed during copy.");
    }
    ollamaRuntimeNotice = Object.freeze({ path: "OLLAMA_RUNTIME_NOTICES.md", ...staged });
  }
  return Object.freeze({
    dependencyNotice,
    electron: Object.freeze(electron),
    ollamaRuntimeNotice,
  });
}

function removeGeneratedOutput(path: string) {
  if (!existsSync(path)) return;
  const makeWritable = (entryPath: string) => {
    const status = lstatSync(entryPath);
    if (status.isSymbolicLink()) return;
    if (status.isDirectory()) {
      chmodSync(entryPath, 0o700);
      for (const name of readdirSync(entryPath)) makeWritable(resolve(entryPath, name));
    } else if (status.isFile()) chmodSync(entryPath, 0o600);
    else throw new Error(`Generated desktop output contains an unsupported entry: ${entryPath}.`);
  };
  makeWritable(path);
  rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function nativeModules(target: DesktopArtifactTarget): DesktopNativeModuleVersion[] {
  return [
    "@duckdb/node-api",
    "@duckdb/node-bindings",
    `@duckdb/node-bindings-${target.platform}-${target.arch}`,
    "sqlite-vec",
    target.platform === "darwin" ? `sqlite-vec-darwin-${target.arch}` : `sqlite-vec-windows-${target.arch}`,
  ].map((name) => ({ name, version: packageVersion(name) }));
}

function loadWebFeedback(): DesktopWebFeedbackIdentity {
  const candidate = JSON.parse(readFileSync(resolve(projectRoot, "config", "response-feedback-candidate.json"), "utf8")) as Record<string, unknown>;
  return {
    state: "known",
    candidateBuildId: String(candidate.candidateBuildId ?? ""),
    build: String(candidate.build ?? ""),
    baseCommit: String(candidate.baseCommit ?? ""),
    manifestSha256: String(candidate.manifestSha256 ?? ""),
    // This is the already-merged PR #102 production build artifact evidence.
    // The new desktop ID separately binds the full staged desktop resource tree.
    artifactSha256: WEB_FEEDBACK_ARTIFACT_SHA256,
    sourceVersion: String(candidate.sourceVersion ?? ""),
  };
}

function sourceManifest() {
  const files = collectResponseFeedbackCandidateFiles(projectRoot);
  const present = new Set(files.map((file) => file.path));
  for (const path of desktopSourceFiles) {
    if (!present.has(path)) throw new Error(`Desktop source manifest is missing ${path}.`);
  }
  return { files, sha256: deriveDesktopSourceManifestSha256(files) };
}

function buildStandalone(stagingBuildId: string) {
  rmSync(resolve(projectRoot, ".next"), { recursive: true, force: true });
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    RANGABOT_DESKTOP_STAGING_BUILD_ID: stagingBuildId,
  };
  for (const key of [
    "HOME", "LANG", "LC_ALL", "LC_CTYPE", "PATH", "TZ",
    "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "ComSpec", "PATHEXT",
  ]) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  const result = spawnSync(process.execPath, [resolve(projectRoot, "node_modules", "next", "dist", "bin", "next"), "build"], {
    cwd: projectRoot,
    env: environment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.signal) throw new Error("The clean desktop Next standalone build failed.");
  const buildId = readFileSync(resolve(projectRoot, ".next", "BUILD_ID"), "utf8").trim();
  if (buildId !== stagingBuildId) throw new Error("The desktop standalone build is not bound to the source staging identity.");
}

function prepareOfflineElectronZip(target: DesktopArtifactTarget) {
  const electronVersion = packageVersion("electron");
  const zipRoot = resolve(outputRoot, "electron-zips");
  mkdirSync(zipRoot, { recursive: true, mode: 0o755 });
  if (target.platform === "win32") {
    const zipPath = resolve(zipRoot, `electron-v${electronVersion}-win32-x64.zip`);
    if (!existsSync(zipPath) || sha256File(zipPath) !== ELECTRON_WINDOWS_X64_SHA256) {
      rmSync(zipPath, { force: true });
      execFileSync("curl.exe", ["--fail", "--location", "--show-error", "--output", zipPath,
        `https://github.com/electron/electron/releases/download/v${electronVersion}/electron-v${electronVersion}-win32-x64.zip`], { stdio: "inherit" });
    }
    if (sha256File(zipPath) !== ELECTRON_WINDOWS_X64_SHA256) throw new Error("The pinned Windows Electron archive checksum is invalid.");
    return zipPath;
  }
  if (target.arch !== "arm64") {
    throw new Error("Desktop preparation supports exactly macOS arm64 or Windows x64.");
  }
  const distribution = process.env.RANGABOT_DESKTOP_DISTRIBUTION;
  if (distribution !== undefined && distribution !== "mas-development" && distribution !== "mas-distribution") {
    throw new Error("The desktop distribution is not recognized.");
  }
  if (distribution?.startsWith("mas-")) {
    const zipPath = resolve(zipRoot, `electron-v${electronVersion}-mas-${target.arch}.zip`);
    if (!existsSync(zipPath) || sha256File(zipPath) !== ELECTRON_MAS_ARM64_SHA256) {
      rmSync(zipPath, { force: true });
      execFileSync("/usr/bin/curl", ["--fail", "--location", "--show-error", "--output", zipPath,
        `https://github.com/electron/electron/releases/download/v${electronVersion}/electron-v${electronVersion}-mas-${target.arch}.zip`], { stdio: "inherit" });
    }
    if (sha256File(zipPath) !== ELECTRON_MAS_ARM64_SHA256) {
      throw new Error("The pinned Mac App Store Electron archive checksum is invalid.");
    }
    return zipPath;
  }
  const appPath = resolve(projectRoot, "node_modules", "electron", "dist", "Electron.app");
  const executable = resolve(appPath, "Contents", "MacOS", "Electron");
  if (!existsSync(executable)) throw new Error("The exact installed Electron app is unavailable for offline packaging.");
  const reported = execFileSync("/usr/bin/lipo", ["-archs", executable], { encoding: "utf8" }).trim().split(/\s+/);
  if (reported.length !== 1 || reported[0] !== "arm64") {
    throw new Error(`The installed Electron app does not provide an exact ${target.arch} payload.`);
  }
  const zipPath = resolve(zipRoot, `electron-v${electronVersion}-darwin-${target.arch}.zip`);
  rmSync(zipPath, { force: true });
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath], { stdio: "inherit" });
  if (!existsSync(zipPath) || !lstatSync(zipPath).isFile()) throw new Error("The offline Electron package input was not created.");
  return zipPath;
}

function stageStandalone(target: DesktopArtifactTarget, resourceRoot: string) {
  const standalone = resolve(projectRoot, ".next", "standalone");
  copyDirectory(standalone, resourceRoot);
  // Next file tracing is not a private-data packaging policy. Remove any
  // traced data or generated-output tree, then add only explicit immutable
  // public-safe assets. A prior desktop candidate must never become a nested
  // resource of the next candidate merely because Next traced its metadata.
  rmSync(resolve(resourceRoot, "data"), { recursive: true, force: true });
  rmSync(resolve(resourceRoot, "out"), { recursive: true, force: true });
  rmSync(resolve(resourceRoot, "desktop"), { recursive: true, force: true });
  // Node middleware tracing does not currently honor the global Next tracing
  // exclusion, so remove its conservative source-only test capture as well.
  rmSync(resolve(resourceRoot, "tests"), { recursive: true, force: true });
  rmSync(resolve(resourceRoot, "tsconfig.json"), { force: true });
  copyDirectory(resolve(projectRoot, ".next", "static"), resolve(resourceRoot, ".next", "static"));
  copyDirectory(resolve(projectRoot, "public"), resolve(resourceRoot, "public"));
  copyFile(resolve(projectRoot, "lib", "sql-runtime-worker.cjs"), resolve(resourceRoot, "lib", "sql-runtime-worker.cjs"));
  for (const path of ["CHANGELOG.md", "package-lock.json"]) copyFile(resolve(projectRoot, path), resolve(resourceRoot, path));
  for (const path of ["NEW_THIS_WEEK.md", "NEW_THIS_MONTH.md", "SOURCE_MANIFEST.json"]) {
    copyFile(resolve(projectRoot, "data", "knowledge", path), resolve(resourceRoot, "data", "knowledge", path));
  }
  copyDirectory(resolve(projectRoot, "data", "knowledge", "evaluations"), resolve(resourceRoot, "data", "knowledge", "evaluations"));
  for (const name of nativeModules(target).map((entry) => entry.name)) {
    copyDirectory(resolve(projectRoot, "node_modules", ...name.split("/")), resolve(resourceRoot, "node_modules", ...name.split("/")));
  }
  for (const path of requiredResourcePaths) {
    if (!existsSync(resolve(resourceRoot, path))) throw new Error(`Staged desktop payload is missing ${path}.`);
  }
}

function materializeSafeStagedSymlinks(directory: string, resourceRoot: string) {
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry);
    const status = lstatSync(path);
    if (status.isSymbolicLink()) {
      const target = realpathSync(path);
      const insideProject = relative(projectRoot, target);
      const insideStaging = relative(resourceRoot, target);
      const isContained = (candidate: string) => candidate === ""
        || (candidate !== ".." && !candidate.startsWith("../") && !isAbsolute(candidate));
      const safe = isContained(insideProject) || isContained(insideStaging);
      if (!safe) throw new Error(`Desktop standalone symlink escaped controlled roots: ${relative(resourceRoot, path)}.`);
      rmSync(path);
      const targetStatus = lstatSync(target);
      if (targetStatus.isDirectory()) cpSync(target, path, { recursive: true, dereference: true, preserveTimestamps: false });
      else if (targetStatus.isFile()) cpSync(target, path, { dereference: true, preserveTimestamps: false });
      else throw new Error(`Desktop standalone symlink targets an unsupported entry: ${relative(resourceRoot, path)}.`);
      if (lstatSync(path).isDirectory()) materializeSafeStagedSymlinks(path, resourceRoot);
    } else if (status.isDirectory()) materializeSafeStagedSymlinks(path, resourceRoot);
    else if (!status.isFile()) throw new Error(`Desktop standalone contains an unsupported entry: ${relative(resourceRoot, path)}.`);
  }
}

function assertNoPrivatePayload(files: readonly DesktopArtifactFile[]) {
  const forbidden = files.find((file) => {
    const lower = file.path.toLowerCase();
    return /(^|\/)(?:\.git|\.env(?:\.|$)|tests?)(?:\/|$)/.test(lower)
      || /^(?:out|desktop)(?:\/|$)/.test(lower)
      || lower === "tsconfig.json"
      || isForbiddenDesktopPrivateResourcePath(file.path);
  });
  if (forbidden) throw new Error(`Desktop resource payload contains a forbidden private/developer path: ${forbidden.path}.`);
}

function assertNoBrokenSharpPayload(files: readonly DesktopArtifactFile[]) {
  const forbidden = files.find((file) => {
    const lower = file.path.toLowerCase();
    return /(^|\/)node_modules\/(?:sharp|@img)(?:\/|$)/.test(lower)
      || /(^|\/)sharp[^/]*\.node$/.test(lower)
      || /(^|\/)libvips[^/]*\.(?:dylib|so|dll)$/.test(lower);
  });
  if (forbidden) {
    throw new Error(`Desktop standalone unexpectedly contains the disabled Sharp/libvips runtime: ${forbidden.path}.`);
  }
}

const target = parseTarget(process.argv.slice(2));
const { arch } = target;
const desktopDistribution = process.env.RANGABOT_DESKTOP_DISTRIBUTION;
if (desktopDistribution !== undefined
  && desktopDistribution !== "mas-development"
  && desktopDistribution !== "mas-distribution") {
  throw new Error("The desktop distribution is not recognized.");
}
if (desktopDistribution?.startsWith("mas-") && target.platform !== "darwin") {
  throw new Error("The Mac App Store distribution is macOS-only.");
}
if (process.platform !== target.platform) throw new Error("Desktop packaging must run on the same operating system as its target.");
if (process.env.RANGABOT_DESKTOP_TARGET_PLATFORM !== target.platform
  || process.env.RANGABOT_DESKTOP_TARGET_ARCH !== arch) throw new Error("The prepared desktop target does not match the Forge target.");
const launchProfile = desktopLaunchProfileForBuild(process.env.RANGABOT_DESKTOP_BUILD_PROFILE);
const packageVariant = process.env.RANGABOT_DESKTOP_PACKAGE_VARIANT;
if (packageVariant !== undefined && packageVariant !== NORMAL_REFRESH_PACKAGE_VARIANT) {
  throw new Error("The desktop package output variant is not recognized.");
}
if (launchProfile.kind === DESKTOP_FINDER_VERIFICATION_BUILD_PROFILE && packageVariant !== undefined) {
  throw new Error("The normal package output variant cannot be combined with a verification profile.");
}
if (launchProfile.kind === DESKTOP_FINDER_VERIFICATION_BUILD_PROFILE && (target.platform !== "darwin" || arch !== "arm64")) {
  throw new Error("The Finder verification artifact is currently bound to arm64 only.");
}
assertBaseline();
const commits = sourceCommits();
if (sourceDirty()) throw new Error("Desktop packaging requires an exact clean source commit.");
const source = sourceManifest();
const sourceProductIdentity = productIdentity();
const stagingBuildId = `desktop-stage-${source.sha256.slice(0, 16)}`;
const electronZipPath = prepareOfflineElectronZip(target);
const verification = launchProfile.kind === DESKTOP_FINDER_VERIFICATION_BUILD_PROFILE;
const stagedParent = resolve(outputRoot, verification ? "packaged-resources-verification" : "packaged-resources", target.platform, arch);
// Never let a prior generated staging tree influence Next's file tracer.
removeGeneratedOutput(stagedParent);
const packageOutputRoot = packageVariant === NORMAL_REFRESH_PACKAGE_VARIANT
  ? resolve(outputRoot, "normal-candidate-20260812")
  : resolve(projectRoot, "out");
removeGeneratedOutput(resolve(packageOutputRoot, `${verification ? "RangaBot Verification" : "RangaBot"}-${target.platform}-${arch}`));
if (target.platform === "win32") {
  removeGeneratedOutput(resolve(projectRoot, "out", "make", "msix", "win32", "x64"));
  removeGeneratedOutput(resolve(projectRoot, "out", "make", "zip", "win32", "x64"));
}
buildStandalone(stagingBuildId);
const resourceRoot = resolve(stagedParent, "rangabot-resources");
const manifestPath = resolve(resourceRoot, "desktop", "manifest.json");

const compilation = spawnSync(process.execPath, ["--experimental-strip-types", resolve(projectRoot, "desktop", "electron", "build.ts")], {
  cwd: projectRoot,
  stdio: "inherit",
});
if (compilation.error) throw compilation.error;
if (compilation.status !== 0 || compilation.signal) throw new Error("Electron shell compilation failed.");

mkdirSync(resourceRoot, { recursive: true, mode: 0o755 });
stageStandalone(target, resourceRoot);
if (!verification) stageManagedModelRuntime(target, resourceRoot);
let ollamaRuntimeLegal: ReturnType<typeof auditOllamaArm64RuntimePayload> | null = null;
if (!verification && target.platform === "darwin") {
  if (target.arch !== "arm64") {
    throw new Error("The managed macOS x64 Ollama runtime has no reviewed target-specific legal inventory.");
  }
  ollamaRuntimeLegal = auditOllamaArm64RuntimePayload(resolve(resourceRoot, "runtime", "ollama"));
}
materializeSafeStagedSymlinks(resourceRoot, resourceRoot);
const legalPayload = stageDesktopLegalPayload(resourceRoot, target, !verification);
const resources = collectDesktopArtifactFiles(resourceRoot);
assertNoPrivatePayload(resources);
assertNoBrokenSharpPayload(resources);
const natives = resources.filter((file) => /\.(?:node|dylib|so|dll|exe)$/i.test(file.path));
const confirmedCommits = sourceCommits();
const confirmedSource = sourceManifest();
if (sourceDirty()
  || confirmedCommits.base !== commits.base
  || confirmedCommits.head !== commits.head
  || confirmedSource.sha256 !== source.sha256
  || JSON.stringify(confirmedSource.files) !== JSON.stringify(source.files)
  || JSON.stringify(productIdentity()) !== JSON.stringify(sourceProductIdentity)) {
  throw new Error("Desktop source identity changed during packaging preparation.");
}
const generatedAt = new Date().toISOString();
const manifest = createDesktopArtifactManifest({
  sourceBaseCommit: commits.base,
  sourceBaselineCommit: DESKTOP_SOURCE_BASELINE_COMMIT,
  sourceCommit: commits.head,
  sourceDirty: false,
  sourceManifestSha256: source.sha256,
  sourceFiles: source.files,
  packageLockSha256: sha256File(resolve(projectRoot, "package-lock.json")),
  productVersion: sourceProductIdentity.productVersion,
  macBuildNumber: target.platform === "darwin" ? sourceProductIdentity.macBuildNumber : null,
  webFeedback: loadWebFeedback(),
  launchProfile,
  runtimeVersions: {
    electron: packageVersion("electron"),
    embeddedNode: "24.18.1",
    next: packageVersion("next"),
    nativeModules: nativeModules(target),
  },
  target,
  fuses: REQUIRED_DESKTOP_FUSE_POLICY,
  packagingTooling: {
    electronForge: packageVersion("@electron-forge/cli"),
    electronFuses: packageVersion("@electron/fuses"),
    fuseWireVersion: "1",
    fuseWireStates: [...REQUIRED_DESKTOP_FUSE_WIRE_STATES],
    fuseInspection: {
      inspectedPath: desktopFuseBinaryPath(target.platform),
      wireVersion: "1",
      wireLength: 9,
      entries: REQUIRED_DESKTOP_FUSE_WIRE_STATES.map((state, index) => ({
        index,
        name: REQUIRED_DESKTOP_FUSE_NAMES[index],
        expected: state,
        actual: state,
      })),
    },
    signature: {
      mode: desktopDistribution?.startsWith("mas-")
        ? desktopDistribution === "mas-development" ? "app-store-development" : "app-store-distribution"
        : target.platform === "darwin" ? "adhoc" : "unsigned-candidate",
      postFuseMutation: false,
      deepStrictVerified: false,
    },
  },
  bundleFiles: [],
  resources,
  natives,
  generatedAt,
});
mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: target.platform === "win32" ? 0o600 : 0o444 });
console.log(JSON.stringify({
  desktopArtifactId: manifest.desktopArtifactId,
  sourceBaseCommit: manifest.sourceBaseCommit,
  profilesBehaviorCommit: manifest.sourceBaselineCommit,
  packagingCommit: manifest.sourceCommit,
  productVersion: manifest.productVersion,
  macBuildNumber: manifest.macBuildNumber,
  sourceDirty: manifest.sourceDirty,
  target: manifest.target,
  launchProfile: manifest.launchProfile,
  sourceManifestSha256: manifest.sourceManifestSha256,
  stagingBuildId,
  packageLockSha256: manifest.packageLockSha256,
  dependencyNotice: {
    dependencies: legalPayload.dependencyNotice.dependencies.length,
    bytes: legalPayload.dependencyNotice.noticeBytes,
    sha256: legalPayload.dependencyNotice.noticeSha256,
  },
  electronLegalPayload: legalPayload.electron,
  ollamaRuntimeLegal: ollamaRuntimeLegal === null ? null : {
    retainedFiles: ollamaRuntimeLegal.files,
    executable: ollamaRuntimeLegal.executable,
    notice: legalPayload.ollamaRuntimeNotice,
  },
  resourceManifestSha256: manifest.resourceManifestSha256,
  nativeManifestSha256: manifest.nativeManifestSha256,
  resources: manifest.resources.length,
  natives: manifest.natives.length,
  manifestPath,
  electronZipPath,
}, null, 2));
