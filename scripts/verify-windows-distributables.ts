import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { createRequire } from "node:module";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDesktopArtifactManifest } from "../lib/desktop-artifact-identity.ts";
import { writeSafeAtomicJsonEvidence } from "../lib/safe-atomic-json-output.ts";
import {
  verifySquirrelNupkgApplicationPayload,
  verifySquirrelSetupEmbeddedPayload,
} from "../lib/windows-squirrel-setup.ts";

const projectRoot = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { assertWindowsPeCertificateTableAbsent } = require("../desktop/electron/windows-pe-certificate.cjs") as {
  assertWindowsPeCertificateTableAbsent(path: string, label?: string): Readonly<{
    embeddedPeCertificateTable: "absent";
  }>;
};
const {
  assertPreparedSquirrelVendor,
  assertSquirrelWorkVendorAfterMake,
} = require("../desktop/electron/windows-squirrel-vendor.cjs") as {
  assertPreparedSquirrelVendor(directory: string): Readonly<{
    directory: string;
    manifest: Readonly<Record<string, unknown>>;
  }>;
  assertSquirrelWorkVendorAfterMake(input: {
    referenceDirectory: string;
    workDirectory: string;
  }): Readonly<{
    referenceVendorInventorySha256: string;
    baseFileCount: number;
    baseFilesUnchanged: true;
    permittedRuntimeSideEffect: Readonly<{ name: string; bytes: number }>;
  }>;
};
const maximumReleaseAssetBytes = 2 * 1024 * 1024 * 1024;
const maximumManifestBytes = 4 * 1024 * 1024;
const maximumReleasesBytes = 8192;

type StableRegularFileIdentity = Readonly<{
  device: bigint;
  inode: bigint;
  links: bigint;
  size: bigint;
  modified: bigint;
  changed: bigint;
}>;

export type StableRegularFileEvidence = Readonly<{
  bytes: number;
  sha256: string;
  content?: Buffer;
  identity: StableRegularFileIdentity;
}>;

function fileIdentity(status: BigIntStats): StableRegularFileIdentity {
  return Object.freeze({
    device: status.dev,
    inode: status.ino,
    links: status.nlink,
    size: status.size,
    modified: status.mtimeNs,
    changed: status.ctimeNs,
  });
}

function sameIdentity(left: StableRegularFileIdentity, right: StableRegularFileIdentity) {
  return left.device === right.device && left.inode === right.inode && left.links === right.links
    && left.size === right.size && left.modified === right.modified && left.changed === right.changed;
}

function canonicalPathMatches(path: string) {
  const canonical = realpathSync(path);
  return process.platform === "win32"
    ? canonical.toLowerCase() === path.toLowerCase()
    : canonical === path;
}

function requireRegularFile(path: string, status: BigIntStats, label: string) {
  if (status.isSymbolicLink() || !status.isFile() || status.nlink !== BigInt(1)
    || status.size <= BigInt(0) || !canonicalPathMatches(path)) {
    throw new Error(`${label} must be one real, non-linked regular file.`);
  }
}

export function inspectStableRegularFile(pathInput: string, input: {
  label: string;
  maximumBytes?: number;
  captureContent?: boolean;
}): StableRegularFileEvidence {
  const path = resolve(pathInput);
  const before = lstatSync(path, { bigint: true });
  requireRegularFile(path, before, input.label);
  if (input.maximumBytes !== undefined && before.size >= BigInt(input.maximumBytes)) {
    throw new Error(`${input.label} exceeds its permitted size.`);
  }
  if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${input.label} is too large to inspect safely.`);
  const descriptor = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  const hash = createHash("sha256");
  const captured: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    requireRegularFile(path, opened, input.label);
    if (!sameIdentity(fileIdentity(before), fileIdentity(opened))) throw new Error(`${input.label} changed while it was opened.`);
    let total = 0;
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      const chunk = buffer.subarray(0, count);
      hash.update(chunk);
      if (input.captureContent) captured.push(Buffer.from(chunk));
      total += count;
    }
    const afterRead = fstatSync(descriptor, { bigint: true });
    if (total !== Number(before.size) || !sameIdentity(fileIdentity(before), fileIdentity(afterRead))) {
      throw new Error(`${input.label} changed while it was hashed.`);
    }
  } finally {
    closeSync(descriptor);
  }
  const after = lstatSync(path, { bigint: true });
  requireRegularFile(path, after, input.label);
  const identity = fileIdentity(before);
  if (!sameIdentity(identity, fileIdentity(after))) throw new Error(`${input.label} changed while it was verified.`);
  return Object.freeze({
    bytes: Number(before.size),
    sha256: hash.digest("hex"),
    ...(input.captureContent ? { content: Buffer.concat(captured) } : {}),
    identity,
  });
}

export function assertStableRegularFileUnchanged(pathInput: string, evidence: StableRegularFileEvidence, label: string) {
  const path = resolve(pathInput);
  const current = lstatSync(path, { bigint: true });
  requireRegularFile(path, current, label);
  if (!sameIdentity(evidence.identity, fileIdentity(current))) throw new Error(`${label} changed after it was inspected.`);
}

export async function verifyWindowsDistributables() {
  const expectedFiles = [
    { path: "out/make/squirrel.windows/x64/RangaBot-win32-x64-Setup.exe", maximumBytes: maximumReleaseAssetBytes, captureContent: false },
    { path: "out/make/squirrel.windows/x64/RangaBot-0.1.0-full.nupkg", maximumBytes: maximumReleaseAssetBytes, captureContent: false },
    { path: "out/make/squirrel.windows/x64/RELEASES", maximumBytes: maximumReleasesBytes, captureContent: true },
    { path: "out/make/zip/win32/x64/RangaBot-win32-x64-0.1.0.zip", maximumBytes: maximumReleaseAssetBytes, captureContent: false },
  ];
  const evidence = [];
  const evidenceByPath = new Map<string, StableRegularFileEvidence>();
  for (const expected of expectedFiles.sort((left, right) => left.path.localeCompare(right.path))) {
    const path = resolve(projectRoot, ...expected.path.split("/"));
    const label = `Windows distributable ${relative(projectRoot, path)}`;
    const inspected = inspectStableRegularFile(path, {
      label,
      maximumBytes: expected.maximumBytes,
      captureContent: expected.captureContent,
    });
    const embeddedPeCertificateTable = /\.exe$/i.test(path)
      ? assertWindowsPeCertificateTableAbsent(path, label).embeddedPeCertificateTable
      : null;
    assertStableRegularFileUnchanged(path, inspected, label);
    evidenceByPath.set(path, inspected);
    evidence.push({
      path: relative(projectRoot, path).replaceAll("\\", "/"),
      bytes: inspected.bytes,
      sha256: inspected.sha256,
      embeddedPeCertificateTable,
    });
  }
  const setupPath = resolve(projectRoot, "out", "make", "squirrel.windows", "x64", "RangaBot-win32-x64-Setup.exe");
  const nupkgPath = resolve(projectRoot, "out", "make", "squirrel.windows", "x64", "RangaBot-0.1.0-full.nupkg");
  const releasesPath = resolve(projectRoot, "out", "make", "squirrel.windows", "x64", "RELEASES");
  const setupEvidence = evidenceByPath.get(setupPath);
  const nupkgEvidence = evidenceByPath.get(nupkgPath);
  const releasesEvidence = evidenceByPath.get(releasesPath);
  if (!setupEvidence || !nupkgEvidence || !releasesEvidence?.content) {
    throw new Error("The exact Squirrel candidate files were not inspected.");
  }
  const squirrelVendorReference = assertPreparedSquirrelVendor(resolve(
    projectRoot,
    "desktop",
    "out",
    "squirrel-vendor",
    "win32",
    "x64",
  ));
  const squirrelVendorWork = assertSquirrelWorkVendorAfterMake({
    referenceDirectory: squirrelVendorReference.directory,
    workDirectory: resolve(projectRoot, "desktop", "out", "squirrel-vendor-work", "win32", "x64"),
  });
  const squirrelEmbeddedPayload = await verifySquirrelSetupEmbeddedPayload({
    setupPath,
    setupTemplatePath: resolve(squirrelVendorReference.directory, "Setup.exe"),
    nupkgPath,
    expectedNupkgBytes: nupkgEvidence.bytes,
    expectedNupkgSha256: nupkgEvidence.sha256,
    expectedReleases: releasesEvidence.content.toString("utf8"),
  });
  assertStableRegularFileUnchanged(setupPath, setupEvidence, "Windows Squirrel Setup.exe");
  assertStableRegularFileUnchanged(nupkgPath, nupkgEvidence, "Windows Squirrel full package");
  assertStableRegularFileUnchanged(releasesPath, releasesEvidence, "Windows Squirrel RELEASES");
  const applicationPath = resolve(projectRoot, "out", "RangaBot-win32-x64", "RangaBot.exe");
  const applicationEvidence = inspectStableRegularFile(applicationPath, { label: "Packaged RangaBot.exe" });
  const applicationEmbeddedPeCertificateTable = assertWindowsPeCertificateTableAbsent(
    applicationPath,
    "Packaged RangaBot.exe",
  ).embeddedPeCertificateTable;
  assertStableRegularFileUnchanged(applicationPath, applicationEvidence, "Packaged RangaBot.exe");
  const manifestPath = resolve(projectRoot, "desktop", "out", "desktop-artifact-win32-x64.json");
  const manifestEvidence = inspectStableRegularFile(manifestPath, {
    label: "External Windows artifact manifest",
    maximumBytes: maximumManifestBytes,
    captureContent: true,
  });
  const manifest = parseDesktopArtifactManifest(JSON.parse(manifestEvidence.content?.toString("utf8") ?? ""));
  if (!manifest || manifest.target.platform !== "win32" || manifest.target.arch !== "x64"
    || manifest.packagingTooling.signature.mode !== "unsigned-candidate") {
    throw new Error("The final Windows desktop artifact manifest is missing or invalid.");
  }
  const checkedOutCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
  const expectedSourceSha = process.env.RANGABOT_EXPECTED_SOURCE_SHA ?? null;
  if (manifest.sourceCommit !== checkedOutCommit || (expectedSourceSha && checkedOutCommit !== expectedSourceSha)) {
    throw new Error("The Windows artifact source commit does not match the exact checked-out source SHA.");
  }
  const squirrelNupkgApplication = await verifySquirrelNupkgApplicationPayload({
    nupkgPath,
    expectedApplicationBytes: applicationEvidence.bytes,
    expectedApplicationSha256: applicationEvidence.sha256,
    expectedManifestBytes: manifestEvidence.bytes,
    expectedManifestSha256: manifestEvidence.sha256,
  });
  assertStableRegularFileUnchanged(nupkgPath, nupkgEvidence, "Windows Squirrel full package");
  assertStableRegularFileUnchanged(applicationPath, applicationEvidence, "Packaged RangaBot.exe");
  assertStableRegularFileUnchanged(manifestPath, manifestEvidence, "External Windows artifact manifest");
  const output = resolve(projectRoot, "desktop", "out", "windows-distributables-win32-x64.json");
  writeSafeAtomicJsonEvidence(output, {
    platform: "win32",
    arch: "x64",
    distributionTrust: "unsigned-candidate",
    desktopArtifactId: manifest.desktopArtifactId,
    sourceCommit: manifest.sourceCommit,
    checkedOutCommit,
    expectedSourceSha,
    githubEventSha: process.env.GITHUB_SHA ?? null,
    applicationPath: relative(projectRoot, applicationPath).replaceAll("\\", "/"),
    applicationBytes: applicationEvidence.bytes,
    applicationSha256: applicationEvidence.sha256,
    applicationEmbeddedPeCertificateTable,
    squirrelVendor: {
      role: "sealed-reference",
      path: relative(projectRoot, squirrelVendorReference.directory).replaceAll("\\", "/"),
      manifest: squirrelVendorReference.manifest,
    },
    squirrelVendorWork,
    squirrelEmbeddedPayload,
    squirrelNupkgApplication,
    files: evidence,
  }, "Windows distributable evidence");
  console.log(JSON.stringify({ evidencePath: output, files: evidence }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyWindowsDistributables();
}
