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
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { createRequire } from "node:module";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDesktopArtifactManifest } from "../lib/desktop-artifact-identity.ts";

const projectRoot = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { assertWindowsPeCertificateTableAbsent } = require("../desktop/electron/windows-pe-certificate.cjs") as {
  assertWindowsPeCertificateTableAbsent(path: string, label?: string): Readonly<{
    embeddedPeCertificateTable: "absent";
  }>;
};
const maximumReleaseAssetBytes = 2 * 1024 * 1024 * 1024;
const maximumManifestBytes = 4 * 1024 * 1024;

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
  const expectedPaths = [
    "out/make/squirrel.windows/x64/RangaBot-win32-x64-Setup.exe",
    "out/make/squirrel.windows/x64/RangaBot-0.1.0-full.nupkg",
    "out/make/zip/win32/x64/RangaBot-win32-x64-0.1.0.zip",
  ];
  const files = expectedPaths.map((path) => resolve(projectRoot, ...path.split("/")));
  const evidence = [];
  for (const path of files.sort()) {
    const label = `Windows distributable ${relative(projectRoot, path)}`;
    const inspected = inspectStableRegularFile(path, { label, maximumBytes: maximumReleaseAssetBytes });
    const embeddedPeCertificateTable = /\.exe$/i.test(path)
      ? assertWindowsPeCertificateTableAbsent(path, label).embeddedPeCertificateTable
      : null;
    assertStableRegularFileUnchanged(path, inspected, label);
    evidence.push({
      path: relative(projectRoot, path).replaceAll("\\", "/"),
      bytes: inspected.bytes,
      sha256: inspected.sha256,
      embeddedPeCertificateTable,
    });
  }
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
  const output = resolve(projectRoot, "desktop", "out", "windows-distributables-win32-x64.json");
  writeFileSync(output, `${JSON.stringify({
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
    files: evidence,
  }, null, 2)}\n`);
  console.log(JSON.stringify({ evidencePath: output, files: evidence }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyWindowsDistributables();
}
