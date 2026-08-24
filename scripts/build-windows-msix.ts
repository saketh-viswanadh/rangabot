import { execFileSync } from "node:child_process";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MSIX_APPLICATION_ROOT_RELATIVE_PATH,
  MSIX_OUTPUT_RELATIVE_PATH,
  buildUnsignedMsix,
  inspectPinnedMakeAppx,
  publicMakeAppxToolEvidence,
} from "../lib/windows-msix.ts";
import { writeSafeAtomicJsonEvidence } from "../lib/safe-atomic-json-output.ts";

const projectRoot = resolve(import.meta.dirname, "..");
const gitCommitPattern = /^[0-9a-f]{40}$/u;

function exactSourceBinding() {
  const checkedOutCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: projectRoot,
    encoding: "utf8",
  }).trim();
  const expectedSourceSha = process.env.RANGABOT_EXPECTED_SOURCE_SHA ?? "";
  if (!gitCommitPattern.test(checkedOutCommit) || !gitCommitPattern.test(expectedSourceSha)
    || checkedOutCommit !== expectedSourceSha) {
    throw new Error("MSIX build requires an exact checked-out source SHA binding.");
  }
  return Object.freeze({ checkedOutCommit, expectedSourceSha });
}

export function buildWindowsMsix() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("The direct MSIX builder must run on Windows x64.");
  }
  const source = exactSourceBinding();
  const makeAppx = inspectPinnedMakeAppx();
  const outputPath = resolve(projectRoot, ...MSIX_OUTPUT_RELATIVE_PATH.split("/"));
  const built = buildUnsignedMsix({
    applicationRoot: resolve(projectRoot, ...MSIX_APPLICATION_ROOT_RELATIVE_PATH.split("/")),
    manifestPath: resolve(projectRoot, "desktop", "msix", "AppxManifest.xml"),
    assetsRoot: resolve(projectRoot, "desktop", "msix", "assets"),
    generatedRoot: projectRoot,
    checkedOutCommit: source.checkedOutCommit,
    expectedSourceSha: source.expectedSourceSha,
    mappingPath: resolve(projectRoot, "out", "make", "msix", "win32", "x64", "AppxMapping.txt"),
    outputPath,
    makeAppx,
  });
  const evidencePath = resolve(projectRoot, "desktop", "out", "windows-msix-build-win32-x64.json");
  writeSafeAtomicJsonEvidence(evidencePath, {
    platform: "win32",
    arch: "x64",
    distributionTrust: built.distributionTrust,
    packageSignature: built.packageSignature,
    sourceCommit: source.checkedOutCommit,
    expectedSourceSha: source.expectedSourceSha,
    desktopArtifactId: built.applicationIdentity.desktopArtifactId,
    productVersion: built.applicationIdentity.productVersion,
    applicationIdentity: built.applicationIdentity,
    msixPath: relative(projectRoot, outputPath).replaceAll("\\", "/"),
    msixBytes: built.output.bytes,
    msixSha256: built.output.sha256,
    sourceFileCount: built.sourceFileCount,
    sourceBytes: built.sourceBytes,
    sourceInventorySha256: built.sourceInventorySha256,
    makeAppx: publicMakeAppxToolEvidence(makeAppx),
  }, "Windows MSIX build evidence");
  console.log(JSON.stringify({
    state: "STRUCTURAL_VERIFICATION_PENDING",
    evidencePath: relative(projectRoot, evidencePath).replaceAll("\\", "/"),
    msixPath: relative(projectRoot, outputPath).replaceAll("\\", "/"),
    productVersion: built.applicationIdentity.productVersion,
    msixBytes: built.output.bytes,
    msixSha256: built.output.sha256,
  }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildWindowsMsix();
