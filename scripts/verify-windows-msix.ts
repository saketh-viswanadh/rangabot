import { execFileSync } from "node:child_process";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MSIX_APPLICATION_ROOT_RELATIVE_PATH,
  MSIX_OUTPUT_RELATIVE_PATH,
} from "../lib/windows-msix.ts";
import { assertStableFileUnchanged, inspectStableFile } from "../lib/windows-msix-path-policy.ts";
import { verifyUnsignedMsix } from "../lib/windows-msix-verifier.ts";
import { writeSafeAtomicJsonEvidence } from "../lib/safe-atomic-json-output.ts";

const projectRoot = resolve(import.meta.dirname, "..");
const gitCommitPattern = /^[0-9a-f]{40}$/u;

type BuildEvidence = Readonly<{
  platform?: unknown;
  arch?: unknown;
  distributionTrust?: unknown;
  packageSignature?: unknown;
  sourceCommit?: unknown;
  expectedSourceSha?: unknown;
  desktopArtifactId?: unknown;
  productVersion?: unknown;
  msixPath?: unknown;
  msixBytes?: unknown;
  msixSha256?: unknown;
  makeAppx?: unknown;
}>;

type PublicMakeAppxEvidence = Readonly<{
  sdkVersion: string;
  relativePath: string;
  bytes: number;
  sha256: string;
  fileVersion: string;
  productVersion: string;
  authenticodeStatus: string;
  signerSubject: string;
  attestor: Readonly<{ relativePath: string; bytes: number; sha256: string }>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function parsePublicMakeAppxEvidence(value: unknown): PublicMakeAppxEvidence | null {
  if (!isRecord(value) || !exactKeys(value, [
    "sdkVersion", "relativePath", "bytes", "sha256", "fileVersion", "productVersion",
    "authenticodeStatus", "signerSubject", "attestor",
  ]) || value.sdkVersion !== "10.0.26100.0"
    || value.relativePath !== "Windows Kits/10/bin/10.0.26100.0/x64/MakeAppx.exe"
    || !Number.isSafeInteger(value.bytes) || (value.bytes as number) <= 0
    || typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.sha256)
    || typeof value.fileVersion !== "string" || !value.fileVersion.startsWith("10.0.26100.")
    || typeof value.productVersion !== "string" || !value.productVersion.startsWith("10.0.26100.")
    || value.authenticodeStatus !== "Valid" || typeof value.signerSubject !== "string"
    || !/(?:^|,\s*)O=Microsoft Corporation(?:,|$)/u.test(value.signerSubject)
    || !isRecord(value.attestor) || !exactKeys(value.attestor, ["relativePath", "bytes", "sha256"])
    || value.attestor.relativePath !== "System32/WindowsPowerShell/v1.0/powershell.exe"
    || !Number.isSafeInteger(value.attestor.bytes) || (value.attestor.bytes as number) <= 0
    || typeof value.attestor.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.attestor.sha256)) {
    return null;
  }
  return Object.freeze({
    sdkVersion: value.sdkVersion,
    relativePath: value.relativePath,
    bytes: value.bytes as number,
    sha256: value.sha256,
    fileVersion: value.fileVersion,
    productVersion: value.productVersion,
    authenticodeStatus: value.authenticodeStatus,
    signerSubject: value.signerSubject,
    attestor: Object.freeze({
      relativePath: value.attestor.relativePath,
      bytes: value.attestor.bytes as number,
      sha256: value.attestor.sha256,
    }),
  });
}

function checkedOutSource() {
  const checkedOutCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: projectRoot,
    encoding: "utf8",
  }).trim();
  const expectedSourceSha = process.env.RANGABOT_EXPECTED_SOURCE_SHA ?? "";
  if (!gitCommitPattern.test(checkedOutCommit) || !gitCommitPattern.test(expectedSourceSha)
    || checkedOutCommit !== expectedSourceSha) {
    throw new Error("MSIX verification requires an exact checked-out source SHA binding.");
  }
  return Object.freeze({ checkedOutCommit, expectedSourceSha });
}

export async function verifyWindowsMsix() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("MSIX verification must run on Windows x64.");
  }
  const source = checkedOutSource();
  const msixPath = resolve(projectRoot, ...MSIX_OUTPUT_RELATIVE_PATH.split("/"));
  const buildEvidencePath = resolve(projectRoot, "desktop", "out", "windows-msix-build-win32-x64.json");
  const buildEvidenceFile = inspectStableFile(buildEvidencePath, {
    label: "Windows MSIX build evidence",
    maximumBytes: 1024 * 1024,
    captureContent: true,
  });
  const buildEvidence = JSON.parse(buildEvidenceFile.content?.toString("utf8") ?? "") as BuildEvidence;
  const verified = await verifyUnsignedMsix({
    msixPath,
    applicationRoot: resolve(projectRoot, ...MSIX_APPLICATION_ROOT_RELATIVE_PATH.split("/")),
    manifestPath: resolve(projectRoot, "desktop", "msix", "AppxManifest.xml"),
    assetsRoot: resolve(projectRoot, "desktop", "msix", "assets"),
    checkedOutCommit: source.checkedOutCommit,
    expectedSourceSha: source.expectedSourceSha,
  });
  const makeAppx = parsePublicMakeAppxEvidence(buildEvidence.makeAppx);
  if (buildEvidence.platform !== "win32" || buildEvidence.arch !== "x64"
    || buildEvidence.distributionTrust !== "unsigned-candidate"
    || buildEvidence.packageSignature !== "unverified"
    || buildEvidence.sourceCommit !== verified.sourceCommit
    || buildEvidence.expectedSourceSha !== source.expectedSourceSha
    || buildEvidence.desktopArtifactId !== verified.desktopArtifactId
    || buildEvidence.productVersion !== verified.productVersion
    || buildEvidence.msixPath !== MSIX_OUTPUT_RELATIVE_PATH
    || buildEvidence.msixBytes !== verified.msixBytes
    || buildEvidence.msixSha256 !== verified.msixSha256
    || !makeAppx) {
    throw new Error("MSIX build evidence does not bind the exact structurally verified package.");
  }
  const evidencePath = resolve(projectRoot, "desktop", "out", "windows-msix-win32-x64.json");
  writeSafeAtomicJsonEvidence(evidencePath, {
    ...verified,
    msixPath: MSIX_OUTPUT_RELATIVE_PATH,
    buildEvidencePath: relative(projectRoot, buildEvidencePath).replaceAll("\\", "/"),
    buildEvidenceBytes: buildEvidenceFile.bytes,
    buildEvidenceSha256: buildEvidenceFile.sha256,
    makeAppx,
    publicReleaseEligible: false,
    cleanVmAcceptance: "NOT_RUN",
  }, "Windows MSIX structural evidence");
  assertStableFileUnchanged(buildEvidenceFile, "Windows MSIX build evidence");
  console.log(JSON.stringify({
    state: "STRUCTURAL_CANDIDATE_PASS",
    release: "HOLD",
    packageSignature: verified.packageSignature,
    productVersion: verified.productVersion,
    cleanVmAcceptance: "NOT_RUN",
    evidencePath: relative(projectRoot, evidencePath).replaceAll("\\", "/"),
    msixBytes: verified.msixBytes,
    msixSha256: verified.msixSha256,
  }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await verifyWindowsMsix();
