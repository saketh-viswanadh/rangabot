import { createHash } from "node:crypto";
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isForbiddenDesktopPrivateResourcePath } from "./desktop-private-payload-policy.ts";
import { inspectDesktopArtifact, parseDesktopArtifactManifest } from "./desktop-artifact-identity.ts";
import {
  assertStableFileUnchanged,
  assertUniqueWindowsPackagePaths,
  inspectStableFile,
  validateWindowsPackagePath,
  type StableFileEvidence,
} from "./windows-msix-path-policy.ts";

export const PINNED_WINDOWS_SDK_VERSION = "10.0.26100.0";
export const MAXIMUM_MSIX_BYTES_EXCLUSIVE = 2 * 1024 * 1024 * 1024;
export const MAXIMUM_MSIX_SOURCE_BYTES_EXCLUSIVE = 25 * 1024 * 1024 * 1024;
export const APPROVED_MSIX_MANIFEST_SHA256 = "32b49625b51a5185654a3b1f387f9c651a1dd8735a4f14bfa8cb7b4010bf8162";
export const MSIX_OUTPUT_RELATIVE_PATH = "out/make/msix/win32/x64/RangaBot-win32-x64-0.1.0.msix";
export const MSIX_APPLICATION_ROOT_RELATIVE_PATH = "out/RangaBot-win32-x64";
export const MSIX_DESKTOP_MANIFEST_PACKAGE_PATH = "resources/rangabot-resources/desktop/manifest.json";

const expectedAssetEvidence = Object.freeze({
  "Assets/StoreLogo.png": Object.freeze({ bytes: 4_704, sha256: "58f9fe0de43915b127c1fec9a32257457f93e55cede415c6312500c1acea9740" }),
  "Assets/Square44x44Logo.png": Object.freeze({ bytes: 3_908, sha256: "ae4ecb6a030277efcb54beb76c5d11440039ffed93646adb7a38acfa33423733" }),
  "Assets/Square150x150Logo.png": Object.freeze({ bytes: 27_305, sha256: "f641c514fab9d7c5bf0c4c82ab2fe9dd206586ec9f561b00e0e13d376cdfbd50" }),
});

export type MsixSourceEntry = Readonly<{
  sourcePath: string;
  packagePath: string;
  bytes: number;
  sha256: string;
  source: StableFileEvidence;
}>;

export type MakeAppxToolEvidence = Readonly<{
  path: string;
  sdkVersion: typeof PINNED_WINDOWS_SDK_VERSION;
  bytes: number;
  sha256: string;
  fileVersion: string;
  productVersion: string;
  authenticodeStatus: "Valid";
  signerSubject: string;
  attestor: Readonly<{ relativePath: string; bytes: number; sha256: string }>;
  file: StableFileEvidence;
}>;

function comparablePath(path: string) {
  return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
}

function requireRealDirectory(pathInput: string, label: string) {
  const path = resolve(pathInput);
  const status = lstatSync(path, { bigint: true });
  if (status.isSymbolicLink() || !status.isDirectory()
    || comparablePath(realpathSync(path)) !== comparablePath(path)) {
    throw new Error(`${label} must be one real, non-linked directory.`);
  }
  return path;
}

function walkRealFiles(rootInput: string, label: string) {
  const root = requireRealDirectory(rootInput, label);
  const output: string[] = [];
  const visit = (directory: string) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const status = lstatSync(path, { bigint: true });
      if (entry.isSymbolicLink() || status.isSymbolicLink()) {
        throw new Error(`${label} contains a symbolic link.`);
      }
      if (entry.isDirectory() && status.isDirectory()) visit(path);
      else if (entry.isFile() && status.isFile()) output.push(path);
      else throw new Error(`${label} contains an unsupported filesystem entry.`);
    }
  };
  visit(root);
  return Object.freeze(output);
}

function assertPublicPayloadPath(packagePath: string) {
  const lower = packagePath.toLocaleLowerCase("en-US");
  if (/(?:^|\/)\.ollama(?:\/|$)/u.test(lower)
    || /\.(?:gguf|ggml|safetensors|sqlite|sqlite3|duckdb)$/iu.test(lower)
    || /(?:^|\/)(?:rangabot(?:-memory)?\.db|datasets\.json|repositories\.json|sql-confirmations\.json)(?:$|\/)/u.test(lower)
    || /(?:^|\/)models\/(?:blobs|manifests)(?:\/|$)/u.test(lower)) {
    throw new Error(`MSIX payload path ${packagePath} is private data or a model weight.`);
  }
  const resourcePrefix = "resources/rangabot-resources/";
  if (lower.startsWith(resourcePrefix)
    && isForbiddenDesktopPrivateResourcePath(packagePath.slice(resourcePrefix.length))) {
    throw new Error(`MSIX payload path ${packagePath} violates the desktop private-payload policy.`);
  }
}

function inspectSource(sourcePath: string, packagePathInput: string): MsixSourceEntry {
  const packagePath = validateWindowsPackagePath(packagePathInput, "MSIX destination path");
  assertPublicPayloadPath(packagePath);
  const source = inspectStableFile(sourcePath, { label: `MSIX source ${packagePath}`, allowEmpty: true });
  return Object.freeze({
    sourcePath: source.path,
    packagePath,
    bytes: source.bytes,
    sha256: source.sha256,
    source,
  });
}

export function collectMsixSourceInventory(input: Readonly<{
  applicationRoot: string;
  manifestPath: string;
  assetsRoot: string;
}>) {
  const applicationRoot = requireRealDirectory(input.applicationRoot, "Packaged Windows application");
  const assetsRoot = requireRealDirectory(input.assetsRoot, "MSIX assets");
  const entries: MsixSourceEntry[] = [];
  for (const path of walkRealFiles(applicationRoot, "Packaged Windows application")) {
    const packagePath = validateWindowsPackagePath(relative(applicationRoot, path), "Packaged application path");
    entries.push(inspectSource(path, packagePath));
  }
  entries.push(inspectSource(input.manifestPath, "AppxManifest.xml"));
  for (const path of walkRealFiles(assetsRoot, "MSIX assets")) {
    const packagePath = validateWindowsPackagePath(`Assets/${relative(assetsRoot, path)}`, "MSIX asset path");
    entries.push(inspectSource(path, packagePath));
  }
  entries.sort((left, right) => Buffer.from(left.packagePath).compare(Buffer.from(right.packagePath)));
  assertUniqueWindowsPackagePaths(entries.map((entry) => entry.packagePath), "MSIX source inventory");
  const executable = entries.find((entry) => entry.packagePath === "RangaBot.exe");
  const desktopManifest = entries.find((entry) => entry.packagePath === MSIX_DESKTOP_MANIFEST_PACKAGE_PATH);
  if (!executable || executable.bytes <= 0 || !desktopManifest || desktopManifest.bytes <= 0) {
    throw new Error("MSIX source inventory is missing RangaBot.exe or its desktop provenance manifest.");
  }
  for (const [packagePath, expected] of Object.entries(expectedAssetEvidence)) {
    const actual = entries.find((entry) => entry.packagePath === packagePath);
    if (!actual || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      throw new Error(`MSIX source asset ${packagePath} does not match the approved brand derivative.`);
    }
  }
  return Object.freeze(entries);
}

export function assertMsixSourceInventoryUnchanged(input: Readonly<{
  applicationRoot: string;
  assetsRoot: string;
  entries: readonly MsixSourceEntry[];
}>) {
  const expectedApplicationPaths = input.entries
    .filter((entry) => !entry.packagePath.startsWith("Assets/") && entry.packagePath !== "AppxManifest.xml")
    .map((entry) => entry.packagePath)
    .sort();
  const actualApplicationPaths = walkRealFiles(input.applicationRoot, "Packaged Windows application")
    .map((path) => validateWindowsPackagePath(relative(resolve(input.applicationRoot), path), "Packaged application path"))
    .sort();
  const expectedAssetPaths = input.entries.filter((entry) => entry.packagePath.startsWith("Assets/"))
    .map((entry) => entry.packagePath).sort();
  const actualAssetPaths = walkRealFiles(input.assetsRoot, "MSIX assets")
    .map((path) => validateWindowsPackagePath(`Assets/${relative(resolve(input.assetsRoot), path)}`, "MSIX asset path"))
    .sort();
  if (expectedApplicationPaths.length !== actualApplicationPaths.length
    || expectedApplicationPaths.some((path, index) => path !== actualApplicationPaths[index])
    || expectedAssetPaths.length !== actualAssetPaths.length
    || expectedAssetPaths.some((path, index) => path !== actualAssetPaths[index])) {
    throw new Error("MSIX source inventory changed while the package was built.");
  }
  for (const entry of input.entries) assertStableFileUnchanged(entry.source, `MSIX source ${entry.packagePath}`);
}

function quoteMappingValue(value: string, label: string) {
  if (!value || /["\r\n]/u.test(value)) throw new Error(`${label} cannot be represented in a MakeAppx mapping file.`);
  return `"${value}"`;
}

export function createMakeAppxMapping(entries: readonly MsixSourceEntry[]) {
  assertUniqueWindowsPackagePaths(entries.map((entry) => entry.packagePath), "MakeAppx mapping");
  return `[Files]\r\n${entries.map((entry) => `${quoteMappingValue(entry.sourcePath, "MSIX source path")} ${quoteMappingValue(entry.packagePath.replaceAll("/", "\\"), "MSIX destination path")}`).join("\r\n")}\r\n`;
}

export function makeAppxPackArguments(mappingPath: string, outputPath: string) {
  if (!resolve(mappingPath) || !resolve(outputPath)) throw new Error("MakeAppx paths are required.");
  return Object.freeze(["pack", "/f", resolve(mappingPath), "/p", resolve(outputPath), "/h", "SHA256", "/no", "/v"] as const);
}

export function resolvePinnedMakeAppxPath(input: Readonly<{
  programFilesX86: string;
  requestedSdkVersion?: string;
}>) {
  const requested = input.requestedSdkVersion ?? PINNED_WINDOWS_SDK_VERSION;
  if (requested !== PINNED_WINDOWS_SDK_VERSION) {
    throw new Error(`Windows SDK ${requested} is not the pinned ${PINNED_WINDOWS_SDK_VERSION} toolchain.`);
  }
  const programFiles = requireRealDirectory(input.programFilesX86, "Program Files (x86)");
  const path = resolve(programFiles, "Windows Kits", "10", "bin", PINNED_WINDOWS_SDK_VERSION, "x64", "MakeAppx.exe");
  if (!existsSync(path)) throw new Error(`Pinned Windows SDK ${PINNED_WINDOWS_SDK_VERSION} MakeAppx.exe is unavailable.`);
  return path;
}

export function assertPinnedWindowsToolRootStrings(input: Readonly<{
  systemRoot: string | undefined;
  programFilesX86: string | undefined;
}>) {
  const normalize = (value: string | undefined) => (value ?? "").replaceAll("/", "\\").replace(/\\+$/u, "").toLocaleLowerCase("en-US");
  if (normalize(input.systemRoot) !== "c:\\windows"
    || normalize(input.programFilesX86) !== "c:\\program files (x86)") {
    throw new Error("Windows candidate tooling must use exact protected C:\\Windows and C:\\Program Files (x86) roots.");
  }
  return Object.freeze({
    systemRoot: "C:\\Windows" as const,
    programFilesX86: "C:\\Program Files (x86)" as const,
  });
}

type PowerShellToolMetadata = Readonly<{
  attestedPath?: unknown;
  fileVersion?: unknown;
  productVersion?: unknown;
  status?: unknown;
  signerSubject?: unknown;
}>;

export function makeAppxPowerShellAttestationInvocation(makeAppxPath: string) {
  if (!makeAppxPath || makeAppxPath.includes("\0")) {
    throw new Error("MakeAppx attestation requires one exact filesystem path.");
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    "$p=[Console]::In.ReadToEnd()",
    "if([string]::IsNullOrWhiteSpace($p)){throw 'MakeAppx attestation path is unavailable.'}",
    "$i=[System.Diagnostics.FileVersionInfo]::GetVersionInfo($p)",
    "$s=Get-AuthenticodeSignature -LiteralPath $p",
    "[pscustomobject]@{attestedPath=$p;fileVersion=$i.FileVersion;productVersion=$i.ProductVersion;status=[string]$s.Status;signerSubject=$s.SignerCertificate.Subject}|ConvertTo-Json -Compress",
  ].join(";");
  return Object.freeze({
    args: Object.freeze(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]),
    input: makeAppxPath,
  });
}

export function parseMakeAppxPowerShellAttestation(raw: string, expectedPath: string) {
  if (!expectedPath || expectedPath.includes("\0")) {
    throw new Error("MakeAppx attestation requires one exact filesystem path.");
  }
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Pinned MakeAppx.exe returned invalid attestation metadata.");
  }
  const metadata = parsed as PowerShellToolMetadata;
  if (metadata.attestedPath !== expectedPath
    || typeof metadata.fileVersion !== "string" || !metadata.fileVersion.startsWith("10.0.26100.")
    || typeof metadata.productVersion !== "string" || !metadata.productVersion.startsWith("10.0.26100.")
    || metadata.status !== "Valid" || typeof metadata.signerSubject !== "string"
    || !/(?:^|,\s*)O=Microsoft Corporation(?:,|$)/u.test(metadata.signerSubject)) {
    throw new Error("Pinned MakeAppx.exe does not have the expected path, version, and valid Microsoft signature.");
  }
  return Object.freeze({
    attestedPath: metadata.attestedPath,
    fileVersion: metadata.fileVersion,
    productVersion: metadata.productVersion,
    status: metadata.status,
    signerSubject: metadata.signerSubject,
  });
}

export function inspectPinnedMakeAppx(): MakeAppxToolEvidence {
  if (process.platform !== "win32") throw new Error("MakeAppx inspection must run on Windows.");
  const roots = assertPinnedWindowsToolRootStrings({
    systemRoot: process.env.SystemRoot,
    programFilesX86: process.env["ProgramFiles(x86)"],
  });
  const requestedSdkVersion = process.env.RANGABOT_WINDOWS_SDK_VERSION;
  const path = resolvePinnedMakeAppxPath({
    programFilesX86: roots.programFilesX86,
    ...(requestedSdkVersion ? { requestedSdkVersion } : {}),
  });
  const file = inspectStableFile(path, { label: "Pinned MakeAppx.exe" });
  const systemRoot = requireRealDirectory(roots.systemRoot, "Windows system root");
  const powershell = resolve(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const powershellEvidence = inspectStableFile(powershell, {
    label: "Protected Windows PowerShell attestor",
    requireSingleLink: false,
  });
  const attestation = makeAppxPowerShellAttestationInvocation(path);
  const raw = execFileSync(powershell, [...attestation.args], {
    encoding: "utf8",
    windowsHide: true,
    input: attestation.input,
  }).trim();
  const metadata = parseMakeAppxPowerShellAttestation(raw, path);
  assertStableFileUnchanged(file, "Pinned MakeAppx.exe");
  assertStableFileUnchanged(powershellEvidence, "Protected Windows PowerShell attestor");
  return Object.freeze({
    path,
    sdkVersion: PINNED_WINDOWS_SDK_VERSION,
    bytes: file.bytes,
    sha256: file.sha256,
    fileVersion: metadata.fileVersion,
    productVersion: metadata.productVersion,
    authenticodeStatus: "Valid",
    signerSubject: metadata.signerSubject,
    attestor: Object.freeze({
      relativePath: "System32/WindowsPowerShell/v1.0/powershell.exe",
      bytes: powershellEvidence.bytes,
      sha256: powershellEvidence.sha256,
    }),
    file,
  });
}

function canonicalInventoryDigest(entries: readonly MsixSourceEntry[]) {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(`${entry.packagePath}\0${entry.bytes}\0${entry.sha256}\n`, "utf8");
  }
  return hash.digest("hex");
}

function errorCode(error: unknown) {
  return (error as NodeJS.ErrnoException).code;
}

function assertLexicalPathAbsent(path: string, label: string) {
  try {
    lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} must be lexically absent before packaging.`);
}

function ensureGeneratedDirectory(rootInput: string, directoryInput: string, label: string) {
  const root = requireRealDirectory(rootInput, "MSIX generated-output root");
  const directory = resolve(directoryInput);
  const suffix = relative(root, directory);
  if (!suffix || suffix === ".") return root;
  if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error(`${label} must remain beneath the preverified generated-output root.`);
  }
  let current = root;
  for (const component of suffix.split(sep)) {
    current = join(current, component);
    try {
      const status = lstatSync(current, { bigint: true });
      if (status.isSymbolicLink() || !status.isDirectory()
        || comparablePath(realpathSync(current)) !== comparablePath(current)) {
        throw new Error(`${label} contains a linked or non-directory component.`);
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (errorCode(mkdirError) !== "EEXIST") throw mkdirError;
      }
      requireRealDirectory(current, label);
    }
  }
  return requireRealDirectory(directory, label);
}

export function buildUnsignedMsix(input: Readonly<{
  applicationRoot: string;
  manifestPath: string;
  assetsRoot: string;
  generatedRoot: string;
  checkedOutCommit: string;
  expectedSourceSha: string | null;
  mappingPath: string;
  outputPath: string;
  makeAppx: MakeAppxToolEvidence;
  run?: (file: string, args: readonly string[], options: ExecFileSyncOptions) => void;
}>) {
  if (process.platform !== "win32" && input.run === undefined) throw new Error("MSIX creation must run on Windows.");
  const outputPath = resolve(input.outputPath);
  const mappingPath = resolve(input.mappingPath);
  if (comparablePath(outputPath) === comparablePath(mappingPath)) {
    throw new Error("MSIX output and MakeAppx mapping paths must be distinct.");
  }
  for (const root of [resolve(input.applicationRoot), resolve(input.assetsRoot)]) {
    const prefix = `${comparablePath(root)}${process.platform === "win32" ? "\\" : "/"}`;
    if (comparablePath(outputPath).startsWith(prefix) || comparablePath(mappingPath).startsWith(prefix)) {
      throw new Error("MSIX build outputs cannot be written inside a package input directory.");
    }
  }
  const manifestDirectoryPrefix = `${comparablePath(dirname(resolve(input.manifestPath)))}${process.platform === "win32" ? "\\" : "/"}`;
  if (comparablePath(outputPath).startsWith(manifestDirectoryPrefix)
    || comparablePath(mappingPath).startsWith(manifestDirectoryPrefix)) {
    throw new Error("MSIX build outputs cannot be written beside the immutable package manifest.");
  }
  ensureGeneratedDirectory(input.generatedRoot, dirname(outputPath), "MSIX output directory");
  ensureGeneratedDirectory(input.generatedRoot, dirname(mappingPath), "MakeAppx mapping directory");
  assertLexicalPathAbsent(outputPath, "MSIX output");
  const inventory = collectMsixSourceInventory(input);
  const sourceBytes = inventory.reduce((total, entry) => total + entry.bytes, 0);
  if (sourceBytes >= MAXIMUM_MSIX_SOURCE_BYTES_EXCLUSIVE) {
    throw new Error("MSIX source payload reaches the bounded 25 GiB staging limit.");
  }
  const manifest = inventory.find((entry) => entry.packagePath === "AppxManifest.xml");
  if (!manifest || manifest.sha256 !== APPROVED_MSIX_MANIFEST_SHA256) {
    throw new Error("MSIX manifest hash does not match the approved internal-candidate contract.");
  }
  readExpectedMsixManifestIdentity(manifest.sourcePath);
  const applicationIdentity = assertFinalizedWindowsApplicationIdentity({
    applicationRoot: input.applicationRoot,
    inventory,
    checkedOutCommit: input.checkedOutCommit,
    expectedSourceSha: input.expectedSourceSha,
  });
  assertLexicalPathAbsent(mappingPath, "MakeAppx mapping output");
  writeFileSync(mappingPath, createMakeAppxMapping(inventory), { encoding: "utf8", flag: "wx", mode: 0o600 });
  const mappingEvidence = inspectStableFile(mappingPath, { label: "MakeAppx mapping file" });
  const args = makeAppxPackArguments(mappingPath, outputPath);
  if (args.includes("/nv") || args.includes("/o")) throw new Error("MakeAppx validation or no-clobber policy cannot be disabled.");
  const run = input.run ?? ((file, childArgs, options) => { execFileSync(file, [...childArgs], options); });
  run(input.makeAppx.path, args, { stdio: "inherit", windowsHide: true });
  const output = inspectStableFile(outputPath, {
    label: "Unsigned MSIX candidate",
    maximumBytes: MAXIMUM_MSIX_BYTES_EXCLUSIVE,
  });
  if (output.bytes >= MAXIMUM_MSIX_BYTES_EXCLUSIVE) {
    throw new Error("MSIX output reaches the exact 2 GiB candidate limit.");
  }
  assertMsixSourceInventoryUnchanged({
    applicationRoot: input.applicationRoot,
    assetsRoot: input.assetsRoot,
    entries: inventory,
  });
  assertStableFileUnchanged(mappingEvidence, "MakeAppx mapping file");
  assertStableFileUnchanged(input.makeAppx.file, "Pinned MakeAppx.exe");
  return Object.freeze({
    distributionTrust: "unsigned-candidate" as const,
    packageSignature: "unverified" as const,
    output,
    makeAppxArguments: args,
    sourceFileCount: inventory.length,
    sourceBytes,
    sourceInventorySha256: canonicalInventoryDigest(inventory),
    applicationIdentity,
    makeAppx: input.makeAppx,
  });
}

export function readExpectedMsixManifestIdentity(manifestPath: string) {
  const content = readFileSync(manifestPath, "utf8");
  const count = (pattern: RegExp) => [...content.matchAll(pattern)].length;
  const identity = /<Identity\s+[^>]*Name="([^"]+)"[^>]*Publisher="([^"]+)"[^>]*Version="([^"]+)"[^>]*ProcessorArchitecture="([^"]+)"[^>]*\/>/u.exec(content);
  const application = /<Application\s+[^>]*Id="([^"]+)"[^>]*Executable="([^"]+)"[^>]*EntryPoint="([^"]+)"[^>]*>/u.exec(content);
  const dependency = /<TargetDeviceFamily\s+[^>]*Name="([^"]+)"[^>]*MinVersion="([^"]+)"[^>]*MaxVersionTested="([^"]+)"[^>]*\/>/u.exec(content);
  const visualElements = /<uap:VisualElements\s+[^>]*DisplayName="([^"]+)"[^>]*Description="([^"]+)"[^>]*Square150x150Logo="([^"]+)"[^>]*Square44x44Logo="([^"]+)"[^>]*BackgroundColor="([^"]+)"\s*\/>/u.exec(content);
  const capabilities = [...content.matchAll(/<(?:[A-Za-z0-9_.-]+:)?Capability\s+[^>]*Name="([^"]+)"[^>]*\/>/gu)].map((match) => match[1]);
  if (!identity || !application || !dependency || !visualElements
    || count(/<Package\b/gu) !== 1 || count(/<Identity\b/gu) !== 1
    || count(/<Applications\b/gu) !== 1 || count(/<Application\b/gu) !== 1
    || count(/<Dependencies\b/gu) !== 1 || count(/<TargetDeviceFamily\b/gu) !== 1
    || count(/<Capabilities\b/gu) !== 1 || count(/<uap:VisualElements\b/gu) !== 1
    || identity[1] !== "RangaBot.InternalCandidate"
    || identity[2] !== "CN=RangaBot Internal Candidate, OID.2.25.311729368913984317654407730594956997722=1"
    || identity[3] !== "0.1.0.0" || identity[4] !== "x64"
    || application[1] !== "RangaBotInternalCandidate" || application[2] !== "RangaBot.exe"
    || application[3] !== "Windows.FullTrustApplication"
    || dependency[1] !== "Windows.Desktop" || dependency[2] !== "10.0.17763.0"
    || dependency[3] !== "10.0.26100.0"
    || visualElements[1] !== "RangaBot Internal Candidate"
    || visualElements[2] !== "Unsigned internal Windows candidate for governed testing only."
    || visualElements[3] !== "Assets\\Square150x150Logo.png"
    || visualElements[4] !== "Assets\\Square44x44Logo.png" || visualElements[5] !== "transparent"
    || capabilities.length !== 1 || capabilities[0] !== "runFullTrust"
    || /internetClient/iu.test(content)) {
    throw new Error("MSIX manifest does not match the exact internal full-trust application identity.");
  }
  return Object.freeze({
    name: identity[1], publisher: identity[2], version: identity[3], architecture: identity[4],
    applicationId: application[1], executable: application[2], entryPoint: application[3],
    capabilities: Object.freeze(capabilities),
  });
}

export function assertFinalizedWindowsApplicationIdentity(input: Readonly<{
  applicationRoot: string;
  inventory: readonly MsixSourceEntry[];
  checkedOutCommit: string;
  expectedSourceSha: string | null;
}>) {
  const manifestSource = input.inventory.find((entry) => entry.packagePath === MSIX_DESKTOP_MANIFEST_PACKAGE_PATH);
  if (!manifestSource) throw new Error("Finalized Windows application is missing its desktop provenance manifest.");
  const manifestFile = inspectStableFile(manifestSource.sourcePath, {
    label: "Finalized Windows desktop provenance manifest",
    maximumBytes: 4 * 1024 * 1024,
    captureContent: true,
  });
  if (manifestFile.sha256 !== manifestSource.sha256) {
    throw new Error("Finalized Windows desktop provenance manifest changed during preflight.");
  }
  const manifest = parseDesktopArtifactManifest(JSON.parse(manifestFile.content?.toString("utf8") ?? ""));
  if (!manifest || manifest.target.platform !== "win32" || manifest.target.arch !== "x64"
    || manifest.sourceDirty || manifest.packagingTooling.signature.mode !== "unsigned-candidate"
    || manifest.sourceCommit !== input.checkedOutCommit
    || (input.expectedSourceSha !== null && input.expectedSourceSha !== input.checkedOutCommit)) {
    throw new Error("Finalized Windows application does not bind the exact unsigned win32/x64 source.");
  }
  const verified = inspectDesktopArtifact({
    resourceRoot: resolve(input.applicationRoot, "resources"),
    manifestPath: manifestSource.sourcePath,
    runtime: {
      platform: "win32",
      arch: "x64",
      electron: manifest.runtimeVersions.electron,
      embeddedNode: manifest.runtimeVersions.embeddedNode,
      next: manifest.runtimeVersions.next,
      nativeModules: manifest.runtimeVersions.nativeModules,
    },
  });
  if (verified.state !== "dirty" || verified.reason !== "distribution-unsigned"
    || verified.manifest?.desktopArtifactId !== manifest.desktopArtifactId) {
    throw new Error(`Finalized Windows application identity failed: ${verified.state}/${verified.reason}.`);
  }
  assertStableFileUnchanged(manifestFile, "Finalized Windows desktop provenance manifest");
  return Object.freeze({
    desktopArtifactId: manifest.desktopArtifactId,
    sourceCommit: manifest.sourceCommit,
    manifestBytes: manifestFile.bytes,
    manifestSha256: manifestFile.sha256,
  });
}

export function publicMakeAppxToolEvidence(tool: MakeAppxToolEvidence) {
  return Object.freeze({
    sdkVersion: tool.sdkVersion,
    relativePath: `Windows Kits/10/bin/${tool.sdkVersion}/x64/${basename(tool.path)}`,
    bytes: tool.bytes,
    sha256: tool.sha256,
    fileVersion: tool.fileVersion,
    productVersion: tool.productVersion,
    authenticodeStatus: tool.authenticodeStatus,
    signerSubject: tool.signerSubject,
    attestor: tool.attestor,
  });
}
