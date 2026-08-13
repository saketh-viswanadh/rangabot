import { createHash } from "node:crypto";
import * as nodeFilesystem from "node:fs";
import type { BigIntStats } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import type { ResponseFeedbackCandidateInspection } from "./response-feedback-candidate.ts";
import { parseDesktopLaunchProfile, type DesktopLaunchProfile } from "./desktop-launch-profile.ts";

type ProcessWithBuiltinModule = NodeJS.Process & {
  getBuiltinModule?(name: string): unknown;
};

const electronOriginalFilesystem = process.versions.electron
  ? (process as ProcessWithBuiltinModule).getBuiltinModule?.("original-fs")
  : undefined;
if (process.versions.electron && !electronOriginalFilesystem) {
  throw new Error("Electron raw filesystem access is unavailable for desktop identity verification.");
}
const identityFilesystem = (electronOriginalFilesystem ?? nodeFilesystem) as typeof nodeFilesystem;
const {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  readFileSync,
  readSync,
  readdirSync,
} = identityFilesystem;

export const DESKTOP_ARTIFACT_SCHEMA_VERSION = 2;
export const DESKTOP_SOURCE_BASE_COMMIT = "8b161635f79ac6a572524ba22e3af7364fe08a5b";
export const DESKTOP_SOURCE_BASELINE_COMMIT = "062f7c7c51fe38ad6dd6cf6f09d3c78660447d5c";
export const DESKTOP_FUSE_POLICY_NAME = "electron-43-arm64-launchable-v1";

const sha256Pattern = /^[0-9a-f]{64}$/;
const gitCommitPattern = /^[0-9a-f]{40}$/;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const packageNamePattern = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]{0,127}$/;
const buildPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const nativeFilePattern = /\.(?:dylib|node|so|dll)$/i;
const manifestMaximumBytes = 4 * 1024 * 1024;

export type DesktopArtifactArch = "arm64" | "x64";

export type DesktopArtifactFile = {
  path: string;
  bytes: number;
  sha256: string;
};

export type DesktopNativeModuleVersion = {
  name: string;
  version: string;
};

export type DesktopWebFeedbackIdentity = {
  state: "known";
  candidateBuildId: string;
  build: string;
  baseCommit: string;
  manifestSha256: string;
  artifactSha256: string;
  sourceVersion: string;
};

export type DesktopRuntimeVersions = {
  electron: string;
  embeddedNode: string;
  next: string;
  nativeModules: DesktopNativeModuleVersion[];
};

export type DesktopFusePolicy = {
  policyName: typeof DESKTOP_FUSE_POLICY_NAME;
  runAsNode: false;
  enableCookieEncryption: true;
  enableNodeOptionsEnvironmentVariable: false;
  enableNodeCliInspectArguments: false;
  enableEmbeddedAsarIntegrityValidation: true;
  onlyLoadAppFromAsar: true;
  loadBrowserProcessSpecificV8Snapshot: false;
  grantFileProtocolExtraPrivileges: false;
  wasmTrapHandlers: true;
};

export const REQUIRED_DESKTOP_FUSE_POLICY: DesktopFusePolicy = Object.freeze({
  policyName: DESKTOP_FUSE_POLICY_NAME,
  runAsNode: false,
  enableCookieEncryption: true,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
  loadBrowserProcessSpecificV8Snapshot: false,
  grantFileProtocolExtraPrivileges: false,
  wasmTrapHandlers: true,
});

export const REQUIRED_DESKTOP_FUSE_WIRE_STATES = Object.freeze([
  48, 49, 48, 48, 49, 49, 48, 48, 49,
] as const);

export const REQUIRED_DESKTOP_FUSE_NAMES = Object.freeze([
  "RunAsNode",
  "EnableCookieEncryption",
  "EnableNodeOptionsEnvironmentVariable",
  "EnableNodeCliInspectArguments",
  "EnableEmbeddedAsarIntegrityValidation",
  "OnlyLoadAppFromAsar",
  "LoadBrowserProcessSpecificV8Snapshot",
  "GrantFileProtocolExtraPrivileges",
  "WasmTrapHandlers",
] as const);

export const DESKTOP_FUSE_BINARY_PATH = "Frameworks/Electron Framework.framework/Versions/A/Electron Framework";

export type DesktopFuseInspectionEntry = {
  index: number;
  name: string;
  expected: number;
  actual: number;
};

export type DesktopFuseInspection = {
  inspectedPath: string;
  wireVersion: "1";
  wireLength: 9;
  entries: DesktopFuseInspectionEntry[];
};

export type DesktopPackagingTooling = {
  electronForge: string;
  electronFuses: string;
  fuseWireVersion: "1";
  fuseWireStates: number[];
  fuseInspection: DesktopFuseInspection;
  signature: {
    mode: "adhoc";
    postFuseMutation: boolean;
    deepStrictVerified: boolean;
  };
};

export type DesktopArtifactTarget = {
  platform: "darwin";
  arch: DesktopArtifactArch;
};

export type DesktopArtifactManifest = {
  schemaVersion: 2;
  /** Founder-approved source merge from which Profiles v1 was developed. */
  sourceBaseCommit: string;
  desktopArtifactId: string;
  /** Profiles v1 behavior commit, before the packaging-only identity commit. */
  sourceBaselineCommit: string;
  /** Exact clean packaging commit whose complete Git-visible files were frozen. */
  sourceCommit: string;
  sourceDirty: boolean;
  sourceManifestSha256: string;
  sourceFiles: DesktopArtifactFile[];
  packageLockSha256: string;
  webFeedback: DesktopWebFeedbackIdentity;
  launchProfile: DesktopLaunchProfile;
  runtimeVersions: DesktopRuntimeVersions;
  target: DesktopArtifactTarget;
  fuses: DesktopFusePolicy;
  packagingTooling: DesktopPackagingTooling;
  bundleManifestSha256: string;
  resourceManifestSha256: string;
  nativeManifestSha256: string;
  bundleFiles: DesktopArtifactFile[];
  resources: DesktopArtifactFile[];
  natives: DesktopArtifactFile[];
  generatedAt: string;
};

export type DesktopArtifactManifestInput = Omit<
  DesktopArtifactManifest,
  "schemaVersion" | "desktopArtifactId" | "bundleManifestSha256" | "resourceManifestSha256" | "nativeManifestSha256"
>;

export type DesktopRuntimeEvidence = {
  platform: string;
  arch: string;
  electron: string;
  embeddedNode: string;
  next?: string;
  nativeModules?: DesktopNativeModuleVersion[];
};

const desktopNativePackageNames = (arch: DesktopArtifactArch) => [
  "@duckdb/node-api",
  "@duckdb/node-bindings",
  `@duckdb/node-bindings-darwin-${arch}`,
  "sqlite-vec",
  `sqlite-vec-darwin-${arch}`,
] as const;

export type DesktopArtifactVerificationReason =
  | "known"
  | "manifest-unavailable"
  | "manifest-invalid"
  | "source-dirty"
  | "identity-mismatch"
  | "runtime-mismatch"
  | "resource-mismatch";

export type DesktopArtifactVerification = ResponseFeedbackCandidateInspection & {
  reason: DesktopArtifactVerificationReason;
  manifest: DesktopArtifactManifest | null;
};

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function bytewiseCompare(left: string, right: string) {
  return Buffer.from(left).compare(Buffer.from(right));
}

/** Canonical JSON uses recursively byte-sorted object keys and no whitespace. */
export function canonicalJson(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON cannot encode a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const keys = Object.keys(value).sort(bytewiseCompare);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function digestCanonical(value: JsonValue) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function pathIsSafe(path: string) {
  return Boolean(path)
    && !path.startsWith("/")
    && !path.includes("\\")
    && !/[\0\r\n]/.test(path)
    && !path.split("/").some((part) => !part || part === "." || part === "..");
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(record).sort(bytewiseCompare);
  const orderedExpected = [...expected].sort(bytewiseCompare);
  return actual.length === orderedExpected.length && actual.every((key, index) => key === orderedExpected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeFiles(files: readonly DesktopArtifactFile[]) {
  const paths = new Set<string>();
  const normalized = files.map((file) => {
    if (!pathIsSafe(file.path) || paths.has(file.path)) throw new Error("Desktop artifact files must use unique safe relative paths.");
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error("Desktop artifact file sizes must be non-negative safe integers.");
    if (!sha256Pattern.test(file.sha256)) throw new Error("Desktop artifact files must have lowercase SHA-256 digests.");
    paths.add(file.path);
    return { path: file.path, bytes: file.bytes, sha256: file.sha256 };
  });
  return normalized.sort((left, right) => bytewiseCompare(left.path, right.path));
}

function parseFiles(value: unknown): DesktopArtifactFile[] | null {
  if (!Array.isArray(value)) return null;
  const files: DesktopArtifactFile[] = [];
  const paths = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry) || !exactKeys(entry, ["path", "bytes", "sha256"])
      || typeof entry.path !== "string" || !pathIsSafe(entry.path) || paths.has(entry.path)
      || typeof entry.bytes !== "number" || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
      || typeof entry.sha256 !== "string" || !sha256Pattern.test(entry.sha256)) return null;
    paths.add(entry.path);
    files.push({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 });
  }
  if (files.some((file, index) => index > 0 && bytewiseCompare(files[index - 1].path, file.path) >= 0)) return null;
  return files;
}

function normalizeNativeModules(modules: readonly DesktopNativeModuleVersion[], arch: DesktopArtifactArch) {
  const names = new Set<string>();
  const normalized = modules.map((module) => {
    if (!packageNamePattern.test(module.name) || names.has(module.name)) {
      throw new Error("Native module identities must have unique package names.");
    }
    if (!versionPattern.test(module.version)) throw new Error("Native module versions must be exact portable version strings.");
    names.add(module.name);
    return { name: module.name, version: module.version };
  }).sort((left, right) => bytewiseCompare(left.name, right.name));
  const required = [
    "@duckdb/node-api",
    "@duckdb/node-bindings",
    `@duckdb/node-bindings-darwin-${arch}`,
    "sqlite-vec",
    `sqlite-vec-darwin-${arch}`,
  ];
  if (required.some((name) => !names.has(name))) {
    throw new Error(`Native module identities must include the complete DuckDB and sqlite-vec ${arch} package chain.`);
  }
  return normalized;
}

function parseNativeModules(value: unknown, arch: DesktopArtifactArch): DesktopNativeModuleVersion[] | null {
  if (!Array.isArray(value)) return null;
  const modules: DesktopNativeModuleVersion[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !exactKeys(entry, ["name", "version"])
      || typeof entry.name !== "string" || typeof entry.version !== "string") return null;
    modules.push({ name: entry.name, version: entry.version });
  }
  try {
    const normalized = normalizeNativeModules(modules, arch);
    if (normalized.some((module, index) => module.name !== modules[index]?.name || module.version !== modules[index]?.version)) return null;
    return normalized;
  } catch {
    return null;
  }
}

function validGeneratedAt(value: string) {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function normalizeWebFeedback(identity: DesktopWebFeedbackIdentity): DesktopWebFeedbackIdentity {
  if (identity.state !== "known" || !sha256Pattern.test(identity.candidateBuildId)
    || !buildPattern.test(identity.build) || !gitCommitPattern.test(identity.baseCommit)
    || !sha256Pattern.test(identity.manifestSha256) || !sha256Pattern.test(identity.artifactSha256)
    || !versionPattern.test(identity.sourceVersion)) {
    throw new Error("Desktop packaging requires a complete known production web-feedback identity.");
  }
  return { ...identity };
}

function parseWebFeedback(value: unknown): DesktopWebFeedbackIdentity | null {
  if (!isRecord(value) || !exactKeys(value, [
    "state", "candidateBuildId", "build", "baseCommit", "manifestSha256", "artifactSha256", "sourceVersion",
  ]) || value.state !== "known" || typeof value.candidateBuildId !== "string" || typeof value.build !== "string"
    || typeof value.baseCommit !== "string" || typeof value.manifestSha256 !== "string"
    || typeof value.artifactSha256 !== "string" || typeof value.sourceVersion !== "string") return null;
  try {
    return normalizeWebFeedback(value as DesktopWebFeedbackIdentity);
  } catch {
    return null;
  }
}

function normalizeRuntimeVersions(versions: DesktopRuntimeVersions, arch: DesktopArtifactArch): DesktopRuntimeVersions {
  if (!/^43\./.test(versions.electron) || !versionPattern.test(versions.electron)) {
    throw new Error("The desktop identity must bind an exact Electron 43 version.");
  }
  if (!/^24\./.test(versions.embeddedNode) || !versionPattern.test(versions.embeddedNode)) {
    throw new Error("The desktop identity must bind an exact embedded Node 24 version.");
  }
  if (!/^16\./.test(versions.next) || !versionPattern.test(versions.next)) {
    throw new Error("The desktop identity must bind an exact Next.js 16 version.");
  }
  return {
    electron: versions.electron,
    embeddedNode: versions.embeddedNode,
    next: versions.next,
    nativeModules: normalizeNativeModules(versions.nativeModules, arch),
  };
}

function parseRuntimeVersions(value: unknown, arch: DesktopArtifactArch): DesktopRuntimeVersions | null {
  if (!isRecord(value) || !exactKeys(value, ["electron", "embeddedNode", "next", "nativeModules"])
    || typeof value.electron !== "string" || typeof value.embeddedNode !== "string"
    || typeof value.next !== "string") return null;
  const nativeModules = parseNativeModules(value.nativeModules, arch);
  if (!nativeModules) return null;
  try {
    return normalizeRuntimeVersions({
      electron: value.electron,
      embeddedNode: value.embeddedNode,
      next: value.next,
      nativeModules,
    }, arch);
  } catch {
    return null;
  }
}

function normalizeFuses(fuses: DesktopFusePolicy): DesktopFusePolicy {
  for (const [name, required] of Object.entries(REQUIRED_DESKTOP_FUSE_POLICY)) {
    if (fuses[name as keyof DesktopFusePolicy] !== required) throw new Error(`Unsafe desktop fuse policy: ${name}.`);
  }
  return { ...REQUIRED_DESKTOP_FUSE_POLICY };
}

function normalizeFuseInspection(inspection: DesktopFuseInspection): DesktopFuseInspection {
  if (!isRecord(inspection)
    || !exactKeys(inspection, ["inspectedPath", "wireVersion", "wireLength", "entries"])
    || inspection.inspectedPath !== DESKTOP_FUSE_BINARY_PATH || inspection.wireVersion !== "1"
    || inspection.wireLength !== 9 || !Array.isArray(inspection.entries)
    || inspection.entries.length !== REQUIRED_DESKTOP_FUSE_NAMES.length) {
    throw new Error("Desktop fuse inspection evidence is incomplete.");
  }
  const entries = inspection.entries.map((entry, index) => {
    if (!isRecord(entry) || !exactKeys(entry, ["index", "name", "expected", "actual"])
      || entry.index !== index || entry.name !== REQUIRED_DESKTOP_FUSE_NAMES[index]
      || entry.expected !== REQUIRED_DESKTOP_FUSE_WIRE_STATES[index]
      || entry.actual !== REQUIRED_DESKTOP_FUSE_WIRE_STATES[index]) {
      throw new Error("Desktop fuse inspection does not match the named nine-fuse policy.");
    }
    return {
      index,
      name: REQUIRED_DESKTOP_FUSE_NAMES[index],
      expected: REQUIRED_DESKTOP_FUSE_WIRE_STATES[index],
      actual: REQUIRED_DESKTOP_FUSE_WIRE_STATES[index],
    };
  });
  return {
    inspectedPath: DESKTOP_FUSE_BINARY_PATH,
    wireVersion: "1",
    wireLength: 9,
    entries,
  };
}

function normalizePackagingTooling(tooling: DesktopPackagingTooling): DesktopPackagingTooling {
  if (!versionPattern.test(tooling.electronForge) || !/^7\./.test(tooling.electronForge)
    || tooling.electronFuses !== "2.1.3" || tooling.fuseWireVersion !== "1"
    || !Array.isArray(tooling.fuseWireStates)
    || tooling.fuseWireStates.length !== REQUIRED_DESKTOP_FUSE_WIRE_STATES.length
    || tooling.fuseWireStates.some((state, index) => state !== REQUIRED_DESKTOP_FUSE_WIRE_STATES[index])
    || !isRecord(tooling.fuseInspection)
    || !isRecord(tooling.signature) || !exactKeys(tooling.signature, ["mode", "postFuseMutation", "deepStrictVerified"])
    || tooling.signature.mode !== "adhoc" || typeof tooling.signature.postFuseMutation !== "boolean"
    || typeof tooling.signature.deepStrictVerified !== "boolean") {
    throw new Error("Desktop packaging tooling or raw fuse-wire evidence is incomplete.");
  }
  return {
    electronForge: tooling.electronForge,
    electronFuses: tooling.electronFuses,
    fuseWireVersion: "1",
    fuseWireStates: [...tooling.fuseWireStates],
    fuseInspection: normalizeFuseInspection(tooling.fuseInspection),
    signature: { ...tooling.signature },
  };
}

function parsePackagingTooling(value: unknown): DesktopPackagingTooling | null {
  if (!isRecord(value) || !exactKeys(value, ["electronForge", "electronFuses", "fuseWireVersion", "fuseWireStates", "fuseInspection", "signature"])
    || typeof value.electronForge !== "string" || typeof value.electronFuses !== "string"
    || value.fuseWireVersion !== "1" || !Array.isArray(value.fuseWireStates)
    || value.fuseWireStates.some((state) => typeof state !== "number")) return null;
  try {
    return normalizePackagingTooling(value as DesktopPackagingTooling);
  } catch {
    return null;
  }
}

function parseFuses(value: unknown): DesktopFusePolicy | null {
  const keys = Object.keys(REQUIRED_DESKTOP_FUSE_POLICY);
  if (!isRecord(value) || !exactKeys(value, keys)) return null;
  try {
    return normalizeFuses(value as DesktopFusePolicy);
  } catch {
    return null;
  }
}

function assertNativeInventory(resources: readonly DesktopArtifactFile[], natives: readonly DesktopArtifactFile[], arch: DesktopArtifactArch) {
  const resourcesByPath = new Map(resources.map((file) => [file.path, file]));
  const nativeByPath = new Map(natives.map((file) => [file.path, file]));
  for (const native of natives) {
    const resource = resourcesByPath.get(native.path);
    if (!resource || resource.bytes !== native.bytes || resource.sha256 !== native.sha256 || !nativeFilePattern.test(native.path)) {
      throw new Error("Every native payload must be an identical member of the exact resource inventory.");
    }
    if (/darwin-(?:arm64|x64)/.test(native.path) && !native.path.includes(`darwin-${arch}`)) {
      throw new Error("Native payload inventory contains the wrong macOS architecture.");
    }
  }
  for (const resource of resources) {
    if (nativeFilePattern.test(resource.path) && !nativeByPath.has(resource.path)) {
      throw new Error("The native payload inventory must include every native resource file.");
    }
  }
  const requiredSuffixes = [
    `/@duckdb/node-bindings-darwin-${arch}/duckdb.node`,
    `/@duckdb/node-bindings-darwin-${arch}/libduckdb.dylib`,
    `/sqlite-vec-darwin-${arch}/vec0.dylib`,
  ];
  if (requiredSuffixes.some((suffix) => !natives.some((file) => `/${file.path}`.endsWith(suffix)))) {
    throw new Error(`Native payload inventory is missing required DuckDB or sqlite-vec ${arch} files.`);
  }
}

function fileManifestSha256(kind: "bundle" | "resources" | "natives", target: DesktopArtifactTarget,
  files: readonly DesktopArtifactFile[], nativeModules?: readonly DesktopNativeModuleVersion[]) {
  return digestCanonical({
    schemaVersion: DESKTOP_ARTIFACT_SCHEMA_VERSION,
    kind,
    target,
    ...(nativeModules ? { nativeModules: [...nativeModules] } : {}),
    files: [...files],
  } as JsonValue);
}

export function deriveDesktopSourceManifestSha256(files: readonly DesktopArtifactFile[]) {
  const normalized = normalizeFiles(files);
  return digestCanonical({
    schemaVersion: DESKTOP_ARTIFACT_SCHEMA_VERSION,
    kind: "source",
    files: normalized,
  });
}

function desktopIdentityPayload(manifest: Omit<DesktopArtifactManifest, "desktopArtifactId" | "generatedAt" | "resources" | "natives">) {
  return {
    schemaVersion: manifest.schemaVersion,
    sourceBaseCommit: manifest.sourceBaseCommit,
    sourceBaselineCommit: manifest.sourceBaselineCommit,
    sourceCommit: manifest.sourceCommit,
    sourceDirty: manifest.sourceDirty,
    sourceManifestSha256: manifest.sourceManifestSha256,
    packageLockSha256: manifest.packageLockSha256,
    webFeedback: manifest.webFeedback,
    launchProfile: manifest.launchProfile,
    runtimeVersions: manifest.runtimeVersions,
    target: manifest.target,
    fuses: manifest.fuses,
    packagingTooling: manifest.packagingTooling,
    bundleManifestSha256: manifest.bundleManifestSha256,
    resourceManifestSha256: manifest.resourceManifestSha256,
    nativeManifestSha256: manifest.nativeManifestSha256,
  } satisfies JsonValue;
}

export function canonicalDesktopArtifactIdentity(manifest: DesktopArtifactManifest) {
  return canonicalJson(desktopIdentityPayload(manifest));
}

export function deriveDesktopArtifactId(manifest: DesktopArtifactManifest) {
  return createHash("sha256").update(canonicalDesktopArtifactIdentity(manifest)).digest("hex");
}

export function desktopArtifactBuildName(sourceVersion: string, arch: DesktopArtifactArch, desktopArtifactId: string) {
  if (!versionPattern.test(sourceVersion) || !sha256Pattern.test(desktopArtifactId)) {
    throw new Error("Cannot name a desktop build without valid source and artifact identities.");
  }
  return `${sourceVersion}+desktop.${arch}.${desktopArtifactId.slice(0, 12)}`;
}

export function createDesktopArtifactManifest(input: DesktopArtifactManifestInput): DesktopArtifactManifest {
  if (!gitCommitPattern.test(input.sourceBaseCommit) || !gitCommitPattern.test(input.sourceCommit)) {
    throw new Error("Desktop source commits are incomplete.");
  }
  if (input.sourceBaseCommit !== DESKTOP_SOURCE_BASE_COMMIT) {
    throw new Error(`Desktop artifacts must bind original source base ${DESKTOP_SOURCE_BASE_COMMIT}.`);
  }
  if (input.sourceBaselineCommit !== DESKTOP_SOURCE_BASELINE_COMMIT) {
    throw new Error(`Desktop artifacts must bind source baseline ${DESKTOP_SOURCE_BASELINE_COMMIT}.`);
  }
  if (typeof input.sourceDirty !== "boolean" || !sha256Pattern.test(input.sourceManifestSha256)
    || !sha256Pattern.test(input.packageLockSha256)) throw new Error("Desktop source identity is incomplete.");
  if (input.target.platform !== "darwin" || (input.target.arch !== "arm64" && input.target.arch !== "x64")) {
    throw new Error("Only architecture-specific macOS desktop identities are supported.");
  }
  if (!validGeneratedAt(input.generatedAt)) throw new Error("generatedAt must be a canonical UTC ISO timestamp.");
  const webFeedback = normalizeWebFeedback(input.webFeedback);
  const launchProfile = parseDesktopLaunchProfile(input.launchProfile);
  if (!launchProfile || (launchProfile.kind === "finder-synthetic-v1" && input.target.arch !== "arm64")) {
    throw new Error("The desktop launch profile is invalid for this target.");
  }
  const sourceFiles = normalizeFiles(input.sourceFiles);
  if (deriveDesktopSourceManifestSha256(sourceFiles) !== input.sourceManifestSha256) {
    throw new Error("Desktop source manifest files do not match their bound digest.");
  }
  const runtimeVersions = normalizeRuntimeVersions(input.runtimeVersions, input.target.arch);
  const fuses = normalizeFuses(input.fuses);
  const packagingTooling = normalizePackagingTooling(input.packagingTooling);
  const bundleFiles = normalizeFiles(input.bundleFiles);
  const resources = normalizeFiles(input.resources);
  const natives = normalizeFiles(input.natives);
  assertNativeInventory(resources, natives, input.target.arch);
  if (packagingTooling.signature.postFuseMutation && packagingTooling.signature.deepStrictVerified
    && !bundleFiles.some((file) => file.path === DESKTOP_FUSE_BINARY_PATH)) {
    throw new Error("Final desktop identities must bind the fuse-bearing Electron Framework binary.");
  }
  const bundleManifestSha256 = fileManifestSha256("bundle", input.target, bundleFiles);
  const resourceManifestSha256 = fileManifestSha256("resources", input.target, resources);
  const nativeManifestSha256 = fileManifestSha256("natives", input.target, natives, runtimeVersions.nativeModules);
  const partial = {
    schemaVersion: DESKTOP_ARTIFACT_SCHEMA_VERSION,
    sourceBaseCommit: input.sourceBaseCommit,
    sourceBaselineCommit: input.sourceBaselineCommit,
    sourceCommit: input.sourceCommit,
    sourceDirty: input.sourceDirty,
    sourceManifestSha256: input.sourceManifestSha256,
    sourceFiles,
    packageLockSha256: input.packageLockSha256,
    webFeedback,
    launchProfile,
    runtimeVersions,
    target: { ...input.target },
    fuses,
    packagingTooling,
    bundleManifestSha256,
    resourceManifestSha256,
    nativeManifestSha256,
    bundleFiles,
    resources,
    natives,
    generatedAt: input.generatedAt,
  } as Omit<DesktopArtifactManifest, "desktopArtifactId">;
  const provisional = { ...partial, desktopArtifactId: "0".repeat(64) };
  return { ...partial, desktopArtifactId: deriveDesktopArtifactId(provisional) };
}

export function parseDesktopArtifactManifest(value: unknown): DesktopArtifactManifest | null {
  if (!isRecord(value) || !exactKeys(value, [
    "schemaVersion", "sourceBaseCommit", "desktopArtifactId", "sourceBaselineCommit", "sourceCommit", "sourceDirty", "sourceManifestSha256",
    "sourceFiles", "packageLockSha256", "webFeedback", "launchProfile", "runtimeVersions", "target", "fuses", "packagingTooling", "bundleManifestSha256",
    "resourceManifestSha256", "nativeManifestSha256", "bundleFiles", "resources", "natives", "generatedAt",
  ]) || value.schemaVersion !== DESKTOP_ARTIFACT_SCHEMA_VERSION
    || value.sourceBaseCommit !== DESKTOP_SOURCE_BASE_COMMIT
    || typeof value.desktopArtifactId !== "string" || !sha256Pattern.test(value.desktopArtifactId)
    || value.sourceBaselineCommit !== DESKTOP_SOURCE_BASELINE_COMMIT
    || typeof value.sourceCommit !== "string" || !gitCommitPattern.test(value.sourceCommit)
    || typeof value.sourceDirty !== "boolean"
    || typeof value.sourceManifestSha256 !== "string" || !sha256Pattern.test(value.sourceManifestSha256)
    || typeof value.packageLockSha256 !== "string" || !sha256Pattern.test(value.packageLockSha256)
    || typeof value.bundleManifestSha256 !== "string" || !sha256Pattern.test(value.bundleManifestSha256)
    || typeof value.resourceManifestSha256 !== "string" || !sha256Pattern.test(value.resourceManifestSha256)
    || typeof value.nativeManifestSha256 !== "string" || !sha256Pattern.test(value.nativeManifestSha256)
    || typeof value.generatedAt !== "string" || !validGeneratedAt(value.generatedAt)
    || !isRecord(value.target) || !exactKeys(value.target, ["platform", "arch"])
    || value.target.platform !== "darwin" || (value.target.arch !== "arm64" && value.target.arch !== "x64")) return null;
  const arch = value.target.arch;
  const webFeedback = parseWebFeedback(value.webFeedback);
  const launchProfile = parseDesktopLaunchProfile(value.launchProfile);
  const sourceFiles = parseFiles(value.sourceFiles);
  const runtimeVersions = parseRuntimeVersions(value.runtimeVersions, arch);
  const fuses = parseFuses(value.fuses);
  const packagingTooling = parsePackagingTooling(value.packagingTooling);
  const bundleFiles = parseFiles(value.bundleFiles);
  const resources = parseFiles(value.resources);
  const natives = parseFiles(value.natives);
  if (!webFeedback || !launchProfile || (launchProfile.kind === "finder-synthetic-v1" && arch !== "arm64")
    || !sourceFiles || deriveDesktopSourceManifestSha256(sourceFiles) !== value.sourceManifestSha256
    || !runtimeVersions || !fuses || !packagingTooling || !bundleFiles || !resources || !natives) return null;
  const manifest: DesktopArtifactManifest = {
    schemaVersion: DESKTOP_ARTIFACT_SCHEMA_VERSION,
    sourceBaseCommit: value.sourceBaseCommit,
    desktopArtifactId: value.desktopArtifactId,
    sourceBaselineCommit: value.sourceBaselineCommit,
    sourceCommit: value.sourceCommit,
    sourceDirty: value.sourceDirty,
    sourceManifestSha256: value.sourceManifestSha256,
    sourceFiles,
    packageLockSha256: value.packageLockSha256,
    webFeedback,
    launchProfile,
    runtimeVersions,
    target: { platform: "darwin", arch },
    fuses,
    packagingTooling,
    bundleManifestSha256: value.bundleManifestSha256,
    resourceManifestSha256: value.resourceManifestSha256,
    nativeManifestSha256: value.nativeManifestSha256,
    bundleFiles,
    resources,
    natives,
    generatedAt: value.generatedAt,
  };
  try {
    assertNativeInventory(resources, natives, arch);
    if (manifest.bundleManifestSha256 !== fileManifestSha256("bundle", manifest.target, bundleFiles)
      || manifest.resourceManifestSha256 !== fileManifestSha256("resources", manifest.target, resources)
      || manifest.nativeManifestSha256 !== fileManifestSha256("natives", manifest.target, natives, runtimeVersions.nativeModules)
      || manifest.desktopArtifactId !== deriveDesktopArtifactId(manifest)) return null;
    return manifest;
  } catch {
    return null;
  }
}

function sameSnapshot(left: BigIntStats, right: BigIntStats) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function openVerifiedFile(path: string) {
  const before = lstatSync(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) throw new Error("Desktop artifact inventories accept regular files only.");
  const descriptor = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameSnapshot(before, opened)) throw new Error("Desktop artifact file changed while it was opened.");
    return { descriptor, before };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function verifyOpenedSnapshot(path: string, descriptor: number, before: BigIntStats) {
  const openedAfter = fstatSync(descriptor, { bigint: true });
  const pathAfter = lstatSync(path, { bigint: true });
  if (pathAfter.isSymbolicLink() || !pathAfter.isFile()
    || !sameSnapshot(before, openedAfter) || !sameSnapshot(openedAfter, pathAfter)) {
    throw new Error("Desktop artifact file changed during verification.");
  }
}

function snapshotFile(path: string): DesktopArtifactFile {
  const opened = openVerifiedFile(path);
  try {
    const size = Number(opened.before.size);
    if (!Number.isSafeInteger(size)) throw new Error("Desktop artifact file size is not safely representable.");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < size) {
      const bytesRead = readSync(opened.descriptor, buffer, 0, Math.min(buffer.length, size - position), position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (position !== size) throw new Error("Desktop artifact file was truncated during verification.");
    verifyOpenedSnapshot(path, opened.descriptor, opened.before);
    return { path: "", bytes: size, sha256: hash.digest("hex") };
  } finally {
    closeSync(opened.descriptor);
  }
}

function snapshotSignedMachOCode(path: string): DesktopArtifactFile {
  const opened = openVerifiedFile(path);
  try {
    const size = Number(opened.before.size);
    if (!Number.isSafeInteger(size) || size < 32 || size > 32 * 1024 * 1024) {
      throw new Error("The desktop launcher Mach-O size is invalid.");
    }
    const source = readFileSync(opened.descriptor);
    if (source.length !== size || source.readUInt32LE(0) !== 0xfeedfacf) {
      throw new Error("The desktop launcher must be a thin 64-bit Mach-O executable.");
    }
    const commands = source.readUInt32LE(16);
    let commandOffset = 32;
    let signatureOffset = -1;
    let signatureSize = -1;
    let signatureCommandOffset = -1;
    for (let index = 0; index < commands; index += 1) {
      if (commandOffset + 8 > source.length) throw new Error("The desktop launcher has a truncated Mach-O command table.");
      const command = source.readUInt32LE(commandOffset);
      const commandSize = source.readUInt32LE(commandOffset + 4);
      if (commandSize < 8 || commandOffset + commandSize > source.length) {
        throw new Error("The desktop launcher has an invalid Mach-O load command.");
      }
      if (command === 0x1d) {
        if (signatureCommandOffset !== -1 || commandSize < 16) {
          throw new Error("The desktop launcher has an invalid code-signature command.");
        }
        signatureCommandOffset = commandOffset;
        signatureOffset = source.readUInt32LE(commandOffset + 8);
        signatureSize = source.readUInt32LE(commandOffset + 12);
      }
      commandOffset += commandSize;
    }
    if (signatureCommandOffset === -1 || signatureOffset < commandOffset || signatureSize <= 0
      || signatureOffset + signatureSize > source.length) {
      throw new Error("The desktop launcher has an invalid embedded code signature.");
    }

    // The outer ad-hoc seal necessarily changes after the embedded resource
    // manifest is written. Bind every launcher byte except the circular
    // LC_CODE_SIGNATURE payload and its offset/size fields. Code, load
    // commands, entitlements outside that payload, and appended bytes remain
    // identity-bound, while the final signature is independently verified.
    const prefix = Buffer.from(source.subarray(0, signatureOffset));
    prefix.fill(0, signatureCommandOffset + 8, signatureCommandOffset + 16);
    const suffix = source.subarray(signatureOffset + signatureSize);
    const canonicalBytes = prefix.length + suffix.length;
    const hash = createHash("sha256")
      .update("rangabot-signed-mach-o-code-v1\0")
      .update(prefix)
      .update(suffix)
      .digest("hex");
    verifyOpenedSnapshot(path, opened.descriptor, opened.before);
    return { path: "", bytes: canonicalBytes, sha256: hash };
  } finally {
    closeSync(opened.descriptor);
  }
}

function readManifestFile(path: string) {
  const opened = openVerifiedFile(path);
  try {
    if (opened.before.size > BigInt(manifestMaximumBytes)) throw new Error("Desktop artifact manifest is too large.");
    const source = readFileSync(opened.descriptor, "utf8");
    verifyOpenedSnapshot(path, opened.descriptor, opened.before);
    return source;
  } finally {
    closeSync(opened.descriptor);
  }
}

function explicitAbsoluteRoot(root: string) {
  if (!isAbsolute(root)) throw new Error("Desktop artifact roots must be explicit absolute paths.");
  const normalized = normalize(root);
  const status = lstatSync(normalized);
  if (status.isSymbolicLink() || !status.isDirectory()) throw new Error("Desktop artifact root must be a real directory.");
  return normalized;
}

function packageVersionBelowResourceRoot(resourceRoot: string, packageName: string) {
  const packagePath = join(resourceRoot, "node_modules", ...packageName.split("/"), "package.json");
  const snapshot = snapshotFile(packagePath);
  if (snapshot.bytes > 256 * 1024) throw new Error("A packaged dependency manifest is unexpectedly large.");
  const record = JSON.parse(readManifestFile(packagePath)) as { name?: unknown; version?: unknown };
  if (record.name !== packageName || typeof record.version !== "string" || !versionPattern.test(record.version)) {
    throw new Error(`Packaged dependency identity is invalid: ${packageName}.`);
  }
  return record.version;
}

/** Builds explicit runtime evidence from the immutable resource tree only. */
export function desktopRuntimeEvidenceFromResourceRoot(input: {
  resourceRoot: string;
  platform?: string;
  arch?: string;
  electron?: string;
  embeddedNode?: string;
}): DesktopRuntimeEvidence {
  const root = explicitAbsoluteRoot(input.resourceRoot);
  const arch = input.arch ?? process.arch;
  if (arch !== "arm64" && arch !== "x64") throw new Error("Desktop runtime architecture is unsupported.");
  const next = packageVersionBelowResourceRoot(root, "next");
  const nativeModules = desktopNativePackageNames(arch).map((name) => ({
    name,
    version: packageVersionBelowResourceRoot(root, name),
  }));
  return {
    platform: input.platform ?? process.platform,
    arch,
    electron: input.electron ?? process.versions.electron ?? "",
    embeddedNode: input.embeddedNode ?? process.versions.node,
    next,
    nativeModules,
  };
}

export function collectDesktopArtifactFiles(resourceRoot: string, excludedPaths: readonly string[] = []) {
  const root = explicitAbsoluteRoot(resourceRoot);
  const excluded = new Set<string>();
  for (const path of excludedPaths) {
    if (!pathIsSafe(path) || excluded.has(path)) throw new Error("Excluded desktop resource paths must be unique safe relative paths.");
    excluded.add(path);
  }
  const files: DesktopArtifactFile[] = [];
  const visit = (directory: string, prefix: string) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => bytewiseCompare(left.name, right.name));
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!pathIsSafe(path)) throw new Error("Desktop resource tree contains an unsafe path.");
      const absolute = join(directory, entry.name);
      const status = lstatSync(absolute);
      if (status.isSymbolicLink()) throw new Error("Desktop resource tree contains a symbolic link.");
      if (status.isDirectory()) visit(absolute, path);
      else if (status.isFile()) {
        if (excluded.has(path)) continue;
        files.push({ ...snapshotFile(absolute), path });
      } else throw new Error("Desktop resource tree contains an unsupported filesystem entry.");
    }
  };
  visit(root, "");
  return normalizeFiles(files);
}

/**
 * Inventories the immutable bundle payload outside Contents/Resources.
 * The outer launcher's code is bound through a canonical Mach-O snapshot that
 * excludes only its circular LC_CODE_SIGNATURE payload and offset/size fields;
 * _CodeSignature is excluded because the final outer seal follows the embedded
 * manifest. Every framework/helper file and safe in-bundle symlink is bound,
 * including the framework binary that owns Electron's fuse wire.
 */
export function collectDesktopBundleFiles(contentsRoot: string) {
  const root = explicitAbsoluteRoot(contentsRoot);
  const files: DesktopArtifactFile[] = [];
  const visit = (directory: string, prefix: string) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => bytewiseCompare(left.name, right.name));
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!pathIsSafe(path)) throw new Error("Desktop bundle contains an unsafe path.");
      if (path === "Resources" || path.startsWith("Resources/")
        || path === "_CodeSignature" || path.startsWith("_CodeSignature/")) continue;
      const absolute = join(directory, entry.name);
      const status = lstatSync(absolute);
      if (status.isSymbolicLink()) {
        const target = readlinkSync(absolute);
        if (isAbsolute(target)) throw new Error("Desktop bundle symlinks must remain relative.");
        const resolvedTarget = normalize(join(dirname(absolute), target));
        const targetRelative = relative(root, resolvedTarget);
        if (!targetRelative || targetRelative === ".." || targetRelative.startsWith(`..${sep}`) || isAbsolute(targetRelative)) {
          throw new Error("Desktop bundle symlink escaped Contents.");
        }
        lstatSync(resolvedTarget);
        files.push({
          path,
          bytes: Buffer.byteLength(target),
          sha256: createHash("sha256").update("symlink\0").update(target).digest("hex"),
        });
      } else if (status.isDirectory()) visit(absolute, path);
      else if (status.isFile()) {
        const snapshot = /^MacOS\/[^/]+$/.test(path)
          ? snapshotSignedMachOCode(absolute)
          : snapshotFile(absolute);
        files.push({ ...snapshot, path });
      }
      else throw new Error("Desktop bundle contains an unsupported filesystem entry.");
    }
  };
  visit(root, "");
  const normalized = normalizeFiles(files);
  if (!normalized.some((file) => file.path === DESKTOP_FUSE_BINARY_PATH)) {
    throw new Error("Desktop bundle is missing its fuse-bearing Electron Framework binary.");
  }
  return normalized;
}

export function collectDesktopArtifactFilesAtPaths(rootPath: string, paths: readonly string[]) {
  const root = explicitAbsoluteRoot(rootPath);
  const unique = new Set<string>();
  const files = paths.map((path) => {
    if (!pathIsSafe(path) || unique.has(path)) throw new Error("Explicit desktop artifact paths must be unique safe relative paths.");
    unique.add(path);
    return { ...snapshotFile(join(root, ...path.split("/"))), path };
  });
  return normalizeFiles(files);
}

function sameFiles(left: readonly DesktopArtifactFile[], right: readonly DesktopArtifactFile[]) {
  return left.length === right.length && left.every((file, index) => file.path === right[index]?.path
    && file.bytes === right[index]?.bytes && file.sha256 === right[index]?.sha256);
}

function emptyVerification(state: "unknown" | "dirty" | "mixed", reason: DesktopArtifactVerificationReason,
  manifest: DesktopArtifactManifest | null = null): DesktopArtifactVerification {
  return {
    state,
    candidateBuildId: null,
    build: null,
    baseCommit: null,
    manifestSha256: null,
    artifactSha256: null,
    sourceVersion: null,
    reason,
    manifest,
  };
}

function manifestRelativePath(resourceRoot: string, manifestPath: string) {
  if (!isAbsolute(manifestPath)) throw new Error("Desktop artifact manifest path must be explicit and absolute.");
  const path = relative(resourceRoot, normalize(manifestPath)).split(sep).join("/");
  if (!pathIsSafe(path)) throw new Error("Desktop artifact manifest must be inside the explicit resource root.");
  return path;
}

function runtimeMatches(manifest: DesktopArtifactManifest, runtime: DesktopRuntimeEvidence) {
  if (runtime.platform !== manifest.target.platform || runtime.arch !== manifest.target.arch
    || runtime.electron !== manifest.runtimeVersions.electron
    || runtime.embeddedNode !== manifest.runtimeVersions.embeddedNode
    || (runtime.next !== undefined && runtime.next !== manifest.runtimeVersions.next)) return false;
  if (runtime.nativeModules !== undefined) {
    try {
      const modules = normalizeNativeModules(runtime.nativeModules, manifest.target.arch);
      if (modules.length !== manifest.runtimeVersions.nativeModules.length
        || modules.some((module, index) => module.name !== manifest.runtimeVersions.nativeModules[index]?.name
          || module.version !== manifest.runtimeVersions.nativeModules[index]?.version)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Verifies an installed artifact without Git or ambient working-directory path
 * discovery. Callers must pass the app's immutable resource root and manifest.
 */
export function inspectDesktopArtifact(options: {
  resourceRoot: string;
  manifestPath: string;
  runtime?: DesktopRuntimeEvidence;
}): DesktopArtifactVerification {
  let root: string;
  let manifestPath: string;
  let relativeManifest: string;
  let manifest: DesktopArtifactManifest;
  try {
    root = explicitAbsoluteRoot(options.resourceRoot);
    manifestPath = normalize(options.manifestPath);
    relativeManifest = manifestRelativePath(root, manifestPath);
    const parsed = parseDesktopArtifactManifest(JSON.parse(readManifestFile(manifestPath)));
    if (!parsed) return emptyVerification("unknown", "manifest-invalid");
    manifest = parsed;
  } catch {
    return emptyVerification("unknown", "manifest-unavailable");
  }
  if (manifest.desktopArtifactId !== deriveDesktopArtifactId(manifest)) {
    return emptyVerification("mixed", "identity-mismatch", manifest);
  }
  if (!manifest.packagingTooling.signature.postFuseMutation
    || !manifest.packagingTooling.signature.deepStrictVerified) {
    return emptyVerification("unknown", "manifest-invalid", manifest);
  }
  const runtime = options.runtime ?? {
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron ?? "",
    embeddedNode: process.versions.node,
  };
  if (!runtimeMatches(manifest, runtime)) return emptyVerification("mixed", "runtime-mismatch", manifest);
  try {
    const resources = collectDesktopArtifactFiles(root, [relativeManifest]);
    if (!sameFiles(resources, manifest.resources)) return emptyVerification("mixed", "resource-mismatch", manifest);
    const bundleFiles = collectDesktopBundleFiles(dirname(root));
    if (!sameFiles(bundleFiles, manifest.bundleFiles)) return emptyVerification("mixed", "resource-mismatch", manifest);
  } catch {
    return emptyVerification("mixed", "resource-mismatch", manifest);
  }
  // Dirty build input disables known-build claims only after the installed
  // resource tree itself has passed exact cryptographic verification.
  if (manifest.sourceDirty) return emptyVerification("dirty", "source-dirty", manifest);
  return {
    state: "known",
    candidateBuildId: manifest.desktopArtifactId,
    build: desktopArtifactBuildName(manifest.webFeedback.sourceVersion, manifest.target.arch, manifest.desktopArtifactId),
    baseCommit: manifest.sourceCommit,
    manifestSha256: manifest.sourceManifestSha256,
    artifactSha256: manifest.desktopArtifactId,
    sourceVersion: manifest.webFeedback.sourceVersion,
    reason: "known",
    manifest,
  };
}

export function requireKnownDesktopArtifact(options: Parameters<typeof inspectDesktopArtifact>[0]) {
  const verified = inspectDesktopArtifact(options);
  if (verified.state !== "known" || !verified.manifest) {
    throw new Error(`Desktop artifact identity is ${verified.state}: ${verified.reason}.`);
  }
  return verified;
}
