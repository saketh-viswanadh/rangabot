import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  DESKTOP_FUSE_BINARY_PATH,
  DESKTOP_SOURCE_BASELINE_COMMIT,
  REQUIRED_DESKTOP_FUSE_NAMES,
  REQUIRED_DESKTOP_FUSE_POLICY,
  REQUIRED_DESKTOP_FUSE_WIRE_STATES,
  collectDesktopArtifactFiles,
  createDesktopArtifactManifest,
  deriveDesktopSourceManifestSha256,
  type DesktopArtifactArch,
  type DesktopArtifactFile,
  type DesktopNativeModuleVersion,
  type DesktopWebFeedbackIdentity,
} from "../lib/desktop-artifact-identity.ts";
import {
  desktopLaunchProfileForBuild,
  DESKTOP_FINDER_VERIFICATION_BUILD_PROFILE,
} from "../lib/desktop-launch-profile.ts";
import { collectResponseFeedbackCandidateFiles } from "../lib/response-feedback-candidate.ts";

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

function parseArch(arguments_: string[]): DesktopArtifactArch {
  const values = arguments_.filter((argument) => argument.startsWith("--arch=")).map((argument) => argument.slice(7));
  if (values.length !== 1 || !["arm64", "x64"].includes(values[0]) || arguments_.length !== 1) {
    throw new Error("Usage: npm run desktop:prepare -- --arch=arm64|x64");
  }
  return values[0] as DesktopArtifactArch;
}

function sha256File(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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
  if (head !== DESKTOP_SOURCE_BASELINE_COMMIT) {
    throw new Error(`Desktop packaging must start from ${DESKTOP_SOURCE_BASELINE_COMMIT}; found ${head || "unknown"}.`);
  }
}

function packageVersion(name: string) {
  const path = resolve(projectRoot, "node_modules", ...name.split("/"), "package.json");
  const record = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown; version?: unknown };
  if (record.name !== name || typeof record.version !== "string") throw new Error(`Missing exact package metadata for ${name}.`);
  return record.version;
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

function nativeModules(arch: DesktopArtifactArch): DesktopNativeModuleVersion[] {
  return [
    "@duckdb/node-api",
    "@duckdb/node-bindings",
    `@duckdb/node-bindings-darwin-${arch}`,
    "sqlite-vec",
    `sqlite-vec-darwin-${arch}`,
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
  for (const key of ["HOME", "LANG", "LC_ALL", "LC_CTYPE", "PATH", "TZ"]) {
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

function prepareOfflineElectronZip(arch: DesktopArtifactArch) {
  const electronVersion = packageVersion("electron");
  const appPath = resolve(projectRoot, "node_modules", "electron", "dist", "Electron.app");
  const executable = resolve(appPath, "Contents", "MacOS", "Electron");
  if (!existsSync(executable)) throw new Error("The exact installed Electron app is unavailable for offline packaging.");
  const reported = execFileSync("/usr/bin/lipo", ["-archs", executable], { encoding: "utf8" }).trim().split(/\s+/);
  const expected = arch === "arm64" ? "arm64" : "x86_64";
  if (reported.length !== 1 || reported[0] !== expected) {
    throw new Error(`The installed Electron app does not provide an exact ${arch} payload.`);
  }
  const zipRoot = resolve(outputRoot, "electron-zips");
  const zipPath = resolve(zipRoot, `electron-v${electronVersion}-darwin-${arch}.zip`);
  mkdirSync(zipRoot, { recursive: true, mode: 0o755 });
  rmSync(zipPath, { force: true });
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath], { stdio: "inherit" });
  if (!existsSync(zipPath) || !lstatSync(zipPath).isFile()) throw new Error("The offline Electron package input was not created.");
  return zipPath;
}

function stageStandalone(arch: DesktopArtifactArch, resourceRoot: string) {
  const standalone = resolve(projectRoot, ".next", "standalone");
  copyDirectory(standalone, resourceRoot);
  // Next file tracing is not a private-data packaging policy. Remove any
  // traced data or generated-output tree, then add only explicit immutable
  // public-safe assets. A prior desktop candidate must never become a nested
  // resource of the next candidate merely because Next traced its metadata.
  rmSync(resolve(resourceRoot, "data"), { recursive: true, force: true });
  rmSync(resolve(resourceRoot, "out"), { recursive: true, force: true });
  rmSync(resolve(resourceRoot, "desktop"), { recursive: true, force: true });
  rmSync(resolve(resourceRoot, "tsconfig.json"), { force: true });
  copyDirectory(resolve(projectRoot, ".next", "static"), resolve(resourceRoot, ".next", "static"));
  copyDirectory(resolve(projectRoot, "public"), resolve(resourceRoot, "public"));
  copyFile(resolve(projectRoot, "lib", "sql-runtime-worker.cjs"), resolve(resourceRoot, "lib", "sql-runtime-worker.cjs"));
  for (const path of ["CHANGELOG.md", "package-lock.json"]) copyFile(resolve(projectRoot, path), resolve(resourceRoot, path));
  for (const path of ["NEW_THIS_WEEK.md", "NEW_THIS_MONTH.md", "SOURCE_MANIFEST.json"]) {
    copyFile(resolve(projectRoot, "data", "knowledge", path), resolve(resourceRoot, "data", "knowledge", path));
  }
  copyDirectory(resolve(projectRoot, "data", "knowledge", "evaluations"), resolve(resourceRoot, "data", "knowledge", "evaluations"));
  for (const name of nativeModules(arch).map((entry) => entry.name)) {
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
  const allowedDataFiles = new Set([
    "data/knowledge/NEW_THIS_WEEK.md",
    "data/knowledge/NEW_THIS_MONTH.md",
    "data/knowledge/SOURCE_MANIFEST.json",
    "data/knowledge/evaluations/starter.json",
  ]);
  const forbidden = files.find((file) => {
    const lower = file.path.toLowerCase();
    return /(^|\/)(?:\.git|\.env(?:\.|$)|tests?)(?:\/|$)/.test(lower)
      || /^(?:out|desktop)(?:\/|$)/.test(lower)
      || lower === "tsconfig.json"
      || (/^data\//.test(lower) && !allowedDataFiles.has(file.path))
      || /(?:^|\/)(?:rangabot(?:-memory)?\.db|datasets\.json|repositories\.json|sql-confirmations\.json)(?:$|\/)/.test(lower)
      || /(?:\.sqlite3?|\.duckdb|-wal|-shm|\.journal)$/.test(lower)
      || /^(?:artifacts|inbox|processed|indexes|backups|results)(?:\/|$)/.test(lower);
  });
  if (forbidden) throw new Error(`Desktop resource payload contains a forbidden private/developer path: ${forbidden.path}.`);
}

const arch = parseArch(process.argv.slice(2));
if (process.platform !== "darwin") throw new Error("Desktop packaging is currently authorized for macOS only.");
if (process.env.RANGABOT_DESKTOP_TARGET_ARCH !== arch) throw new Error("The prepared desktop architecture does not match the Forge target.");
const launchProfile = desktopLaunchProfileForBuild(process.env.RANGABOT_DESKTOP_BUILD_PROFILE);
const packageVariant = process.env.RANGABOT_DESKTOP_PACKAGE_VARIANT;
if (packageVariant !== undefined && packageVariant !== NORMAL_REFRESH_PACKAGE_VARIANT) {
  throw new Error("The desktop package output variant is not recognized.");
}
if (launchProfile.kind === DESKTOP_FINDER_VERIFICATION_BUILD_PROFILE && packageVariant !== undefined) {
  throw new Error("The normal package output variant cannot be combined with a verification profile.");
}
if (launchProfile.kind === DESKTOP_FINDER_VERIFICATION_BUILD_PROFILE && arch !== "arm64") {
  throw new Error("The Finder verification artifact is currently bound to arm64 only.");
}
assertBaseline();
const source = sourceManifest();
const stagingBuildId = `desktop-stage-${source.sha256.slice(0, 16)}`;
const electronZipPath = prepareOfflineElectronZip(arch);
const verification = launchProfile.kind === DESKTOP_FINDER_VERIFICATION_BUILD_PROFILE;
const stagedParent = resolve(outputRoot, verification ? "packaged-resources-verification" : "packaged-resources", arch);
// Never let a prior generated staging tree influence Next's file tracer.
removeGeneratedOutput(stagedParent);
const packageOutputRoot = packageVariant === NORMAL_REFRESH_PACKAGE_VARIANT
  ? resolve(outputRoot, "normal-candidate-20260812")
  : resolve(projectRoot, "out");
removeGeneratedOutput(resolve(packageOutputRoot, `${verification ? "RangaBot Verification" : "RangaBot"}-darwin-${arch}`));
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
stageStandalone(arch, resourceRoot);
materializeSafeStagedSymlinks(resourceRoot, resourceRoot);
const resources = collectDesktopArtifactFiles(resourceRoot);
assertNoPrivatePayload(resources);
const natives = resources.filter((file) => /\.(?:node|dylib)$/.test(file.path));
const generatedAt = new Date().toISOString();
const manifest = createDesktopArtifactManifest({
  sourceBaselineCommit: DESKTOP_SOURCE_BASELINE_COMMIT,
  sourceDirty: sourceDirty(),
  sourceManifestSha256: source.sha256,
  sourceFiles: source.files,
  packageLockSha256: sha256File(resolve(projectRoot, "package-lock.json")),
  webFeedback: loadWebFeedback(),
  launchProfile,
  runtimeVersions: {
    electron: packageVersion("electron"),
    embeddedNode: "24.18.1",
    next: packageVersion("next"),
    nativeModules: nativeModules(arch),
  },
  target: { platform: "darwin", arch },
  fuses: REQUIRED_DESKTOP_FUSE_POLICY,
  packagingTooling: {
    electronForge: packageVersion("@electron-forge/cli"),
    electronFuses: packageVersion("@electron/fuses"),
    fuseWireVersion: "1",
    fuseWireStates: [...REQUIRED_DESKTOP_FUSE_WIRE_STATES],
    fuseInspection: {
      inspectedPath: DESKTOP_FUSE_BINARY_PATH,
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
      mode: "adhoc",
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
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o444 });
console.log(JSON.stringify({
  desktopArtifactId: manifest.desktopArtifactId,
  sourceDirty: manifest.sourceDirty,
  target: manifest.target,
  launchProfile: manifest.launchProfile,
  sourceManifestSha256: manifest.sourceManifestSha256,
  stagingBuildId,
  packageLockSha256: manifest.packageLockSha256,
  resourceManifestSha256: manifest.resourceManifestSha256,
  nativeManifestSha256: manifest.nativeManifestSha256,
  resources: manifest.resources.length,
  natives: manifest.natives.length,
  manifestPath,
  electronZipPath,
}, null, 2));
