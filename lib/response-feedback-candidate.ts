import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";
import candidateManifest from "../config/response-feedback-candidate.json" with { type: "json" };
import packageMetadata from "../package.json" with { type: "json" };
import {
  desktopRuntimeEvidenceFromResourceRoot,
  inspectDesktopArtifact,
} from "./desktop-artifact-identity.ts";
import { runtimePaths, runtimeResourcePath } from "./runtime-paths.ts";

export const RESPONSE_FEEDBACK_CANDIDATE_SCHEMA_VERSION = 1;
export const RESPONSE_FEEDBACK_CANDIDATE_MANIFEST_PATH = "config/response-feedback-candidate.json";
export const RESPONSE_FEEDBACK_BUILD_ARTIFACT_PATH = ".next/rangabot-build-artifact.json";

export type ResponseFeedbackCandidateFile = {
  path: string;
  bytes: number;
  sha256: string;
};

export type ResponseFeedbackCandidateManifest = {
  schemaVersion: 1;
  baseCommit: string;
  sourceVersion: string;
  manifestSha256: string;
  candidateBuildId: string;
  build: string;
  files: ResponseFeedbackCandidateFile[];
};

export type ResponseFeedbackBuildArtifactManifest = {
  schemaVersion: 1;
  candidateBuildId: string;
  build: string;
  artifactSha256: string;
  files: ResponseFeedbackCandidateFile[];
};

export type ResponseFeedbackCandidateState = "known" | "dirty" | "mixed" | "unknown";

export type ResponseFeedbackCandidateInspection = {
  state: ResponseFeedbackCandidateState;
  candidateBuildId: string | null;
  build: string | null;
  baseCommit: string | null;
  manifestSha256: string | null;
  artifactSha256: string | null;
  sourceVersion: string | null;
};

export type RuntimeResponseFeedbackCandidateInspection = ResponseFeedbackCandidateInspection & {
  productVersion: string | null;
};

export type KnownResponseFeedbackCandidate = {
  state: "known";
  candidateBuildId: string;
  build: string;
  baseCommit: string;
  manifestSha256: string;
  artifactSha256: string | null;
  sourceVersion: string;
};

const sha256Pattern = /^[0-9a-f]{64}$/;
const gitCommitPattern = /^[0-9a-f]{40}$/;
const sourceVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const buildPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const runtimeProductVersion = sourceVersionPattern.test(packageMetadata.version)
  ? packageMetadata.version
  : null;

function pathIsSafe(path: string) {
  return Boolean(path)
    && !path.startsWith("/")
    && !path.includes("\\")
    && !path.split("/").some((part) => !part || part === "." || part === "..");
}

function comparePaths(left: ResponseFeedbackCandidateFile, right: ResponseFeedbackCandidateFile) {
  return Buffer.from(left.path).compare(Buffer.from(right.path));
}

export function deriveResponseFeedbackCandidate(
  baseCommit: string,
  sourceVersion: string,
  files: ResponseFeedbackCandidateFile[],
) {
  const ordered = files.map((file) => ({ ...file })).sort(comparePaths);
  const payload = JSON.stringify({
    schemaVersion: RESPONSE_FEEDBACK_CANDIDATE_SCHEMA_VERSION,
    baseCommit,
    sourceVersion,
    files: ordered,
  });
  const manifestSha256 = createHash("sha256").update(payload).digest("hex");
  const candidateBuildId = createHash("sha256")
    .update(`${baseCommit}\n${manifestSha256}`)
    .digest("hex");
  return {
    manifestSha256,
    candidateBuildId,
    build: `${sourceVersion}+rfp.${candidateBuildId.slice(0, 12)}`,
    files: ordered,
  };
}

export function deriveResponseFeedbackBuildArtifact(
  candidateBuildId: string,
  build: string,
  files: ResponseFeedbackCandidateFile[],
) {
  const ordered = files.map((file) => ({ ...file })).sort(comparePaths);
  const artifactSha256 = createHash("sha256").update(JSON.stringify({
    schemaVersion: RESPONSE_FEEDBACK_CANDIDATE_SCHEMA_VERSION,
    candidateBuildId,
    build,
    files: ordered,
  })).digest("hex");
  return { artifactSha256, files: ordered };
}

function parseManifest(value: unknown): ResponseFeedbackCandidateManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const exactKeys = ["baseCommit", "build", "candidateBuildId", "files", "manifestSha256", "schemaVersion", "sourceVersion"];
  if (Object.keys(record).sort().join(",") !== exactKeys.sort().join(",")) return null;
  if (record.schemaVersion !== RESPONSE_FEEDBACK_CANDIDATE_SCHEMA_VERSION
    || typeof record.baseCommit !== "string" || !gitCommitPattern.test(record.baseCommit)
    || typeof record.sourceVersion !== "string" || !sourceVersionPattern.test(record.sourceVersion)
    || typeof record.manifestSha256 !== "string" || !sha256Pattern.test(record.manifestSha256)
    || typeof record.candidateBuildId !== "string" || !sha256Pattern.test(record.candidateBuildId)
    || typeof record.build !== "string" || !buildPattern.test(record.build)
    || !Array.isArray(record.files)) return null;
  const files: ResponseFeedbackCandidateFile[] = [];
  const paths = new Set<string>();
  for (const value of record.files) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const file = value as Record<string, unknown>;
    if (Object.keys(file).sort().join(",") !== "bytes,path,sha256"
      || typeof file.path !== "string" || !pathIsSafe(file.path) || paths.has(file.path)
      || typeof file.bytes !== "number" || !Number.isSafeInteger(file.bytes) || file.bytes < 0
      || typeof file.sha256 !== "string" || !sha256Pattern.test(file.sha256)) return null;
    paths.add(file.path);
    files.push({ path: file.path, bytes: file.bytes, sha256: file.sha256 });
  }
  if (files.some((file, index) => index > 0 && comparePaths(files[index - 1], file) >= 0)) return null;
  return {
    schemaVersion: 1,
    baseCommit: record.baseCommit,
    sourceVersion: record.sourceVersion,
    manifestSha256: record.manifestSha256,
    candidateBuildId: record.candidateBuildId,
    build: record.build,
    files,
  };
}

function parseBuildArtifactManifest(value: unknown): ResponseFeedbackBuildArtifactManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const exactKeys = ["artifactSha256", "build", "candidateBuildId", "files", "schemaVersion"];
  if (Object.keys(record).sort().join(",") !== exactKeys.sort().join(",")) return null;
  if (record.schemaVersion !== RESPONSE_FEEDBACK_CANDIDATE_SCHEMA_VERSION
    || typeof record.candidateBuildId !== "string" || !sha256Pattern.test(record.candidateBuildId)
    || typeof record.build !== "string" || !buildPattern.test(record.build)
    || typeof record.artifactSha256 !== "string" || !sha256Pattern.test(record.artifactSha256)
    || !Array.isArray(record.files)) return null;
  const files: ResponseFeedbackCandidateFile[] = [];
  const paths = new Set<string>();
  for (const value of record.files) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const file = value as Record<string, unknown>;
    if (Object.keys(file).sort().join(",") !== "bytes,path,sha256"
      || typeof file.path !== "string" || !pathIsSafe(file.path) || paths.has(file.path)
      || typeof file.bytes !== "number" || !Number.isSafeInteger(file.bytes) || file.bytes < 0
      || typeof file.sha256 !== "string" || !sha256Pattern.test(file.sha256)) return null;
    paths.add(file.path);
    files.push({ path: file.path, bytes: file.bytes, sha256: file.sha256 });
  }
  if (files.some((file, index) => index > 0 && comparePaths(files[index - 1], file) >= 0)) return null;
  return {
    schemaVersion: 1,
    candidateBuildId: record.candidateBuildId,
    build: record.build,
    artifactSha256: record.artifactSha256,
    files,
  };
}

export function collectResponseFeedbackCandidateFiles(root = process.cwd()) {
  const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).split("\0").filter((path) => path && path !== RESPONSE_FEEDBACK_CANDIDATE_MANIFEST_PATH);
  const unique = [...new Set(listed)].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  return unique.map((path): ResponseFeedbackCandidateFile => {
    if (!pathIsSafe(path)) throw new Error("Candidate source contains an unsafe path.");
    const absolute = resolve(root, ...path.split("/"));
    const expectedPrefix = `${resolve(root)}${sep}`;
    if (absolute !== resolve(root) && !absolute.startsWith(expectedPrefix)) throw new Error("Candidate source escapes the repository.");
    const status = lstatSync(absolute);
    if (status.isSymbolicLink() || !status.isFile()) throw new Error("Candidate source must contain regular files only.");
    const bytes = readFileSync(absolute);
    return { path, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
}

const ignoredBuildArtifactRoots = new Set(["cache", "diagnostics", "trace"]);

export function collectResponseFeedbackBuildArtifactFiles(root = process.cwd()) {
  const buildRoot = resolve(root, ".next");
  const externalPackageRoot = `${realpathSync(resolve(root, "node_modules"))}${sep}`;
  const files: ResponseFeedbackCandidateFile[] = [];
  const activeDirectories = new Set<string>();
  const visit = (directory: string, prefix: string) => {
    const realDirectory = realpathSync(directory);
    if (activeDirectories.has(realDirectory)) throw new Error("Build artifact contains a directory cycle.");
    activeDirectories.add(realDirectory);
    try {
      const names = readdirSync(directory).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
      for (const name of names) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (!prefix && ignoredBuildArtifactRoots.has(name)) continue;
        if (path === "rangabot-build-artifact.json" || /^\.rangabot-build-artifact\..+\.tmp$/.test(path)) continue;
        if (!pathIsSafe(path)) throw new Error("Build artifact contains an unsafe path.");
        const absolute = resolve(directory, name);
        const status = lstatSync(absolute);
        if (status.isSymbolicLink()) {
          const target = readlinkSync(absolute);
          const realTarget = realpathSync(absolute);
          if (!realTarget.startsWith(externalPackageRoot)) {
            throw new Error("Build artifact symbolic links must resolve inside this candidate's node_modules.");
          }
          const targetBytes = Buffer.from(target);
          files.push({ path, bytes: targetBytes.byteLength, sha256: createHash("sha256").update(targetBytes).digest("hex") });
          const targetStatus = lstatSync(realTarget);
          if (targetStatus.isDirectory()) visit(realTarget, path);
          else if (targetStatus.isFile()) {
            const bytes = readFileSync(realTarget);
            files.push({ path: `${path}/@target`, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
          } else throw new Error("Build artifact symbolic links must resolve to regular files or directories.");
        } else if (status.isDirectory()) visit(absolute, path);
        else if (status.isFile()) {
          const bytes = readFileSync(absolute);
          files.push({ path, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
        } else throw new Error("Build artifact must contain regular files, directories, or approved package links only.");
      }
    } finally {
      activeDirectories.delete(realDirectory);
    }
  };
  visit(buildRoot, "");
  return files.sort(comparePaths);
}

export function inspectResponseFeedbackBuildArtifact(root: string, candidateBuildId: string, build: string) {
  let buildId: string;
  try { buildId = readFileSync(resolve(root, ".next", "BUILD_ID"), "utf8").trim(); }
  catch { return { state: "unknown" as const, artifactSha256: null }; }
  if (buildId !== build) return { state: "mixed" as const, artifactSha256: null };
  let buildArtifact: ResponseFeedbackBuildArtifactManifest | null;
  try {
    buildArtifact = parseBuildArtifactManifest(JSON.parse(
      readFileSync(resolve(root, RESPONSE_FEEDBACK_BUILD_ARTIFACT_PATH), "utf8"),
    ));
  } catch {
    return { state: "unknown" as const, artifactSha256: null };
  }
  if (!buildArtifact) return { state: "unknown" as const, artifactSha256: null };
  try {
    const artifactFiles = collectResponseFeedbackBuildArtifactFiles(root);
    const derivedArtifact = deriveResponseFeedbackBuildArtifact(candidateBuildId, build, artifactFiles);
    if (buildArtifact.candidateBuildId !== candidateBuildId || buildArtifact.build !== build
      || buildArtifact.artifactSha256 !== derivedArtifact.artifactSha256
      || !sameFiles(buildArtifact.files, artifactFiles)) return { state: "mixed" as const, artifactSha256: null };
    return { state: "known" as const, artifactSha256: buildArtifact.artifactSha256 };
  } catch {
    return { state: "mixed" as const, artifactSha256: null };
  }
}

function sameFiles(left: ResponseFeedbackCandidateFile[], right: ResponseFeedbackCandidateFile[]) {
  return left.length === right.length && left.every((file, index) => file.path === right[index].path
    && file.bytes === right[index].bytes && file.sha256 === right[index].sha256);
}

function packageSourceVersion(root: string) {
  try {
    const packageRecord = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version?: unknown };
    return typeof packageRecord.version === "string" ? packageRecord.version : null;
  } catch {
    return null;
  }
}

function emptyInspection(state: ResponseFeedbackCandidateState): ResponseFeedbackCandidateInspection {
  return {
    state,
    candidateBuildId: null,
    build: null,
    baseCommit: null,
    manifestSha256: null,
    artifactSha256: null,
    sourceVersion: null,
  };
}

export function inspectResponseFeedbackCandidate(options: { root?: string; requireBuildArtifact?: boolean } = {}): ResponseFeedbackCandidateInspection {
  const root = options.root ?? process.cwd();
  const manifest = parseManifest(candidateManifest);
  if (!manifest) return emptyInspection("unknown");
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim().toLowerCase();
    if (!gitCommitPattern.test(head)) return emptyInspection("unknown");
    const lineage = spawnSync("git", ["merge-base", "--is-ancestor", manifest.baseCommit, head], { cwd: root, stdio: "ignore" });
    if (lineage.status !== 0) return emptyInspection("mixed");
    const version = packageSourceVersion(root);
    if (version === null) return emptyInspection("unknown");
    if (version !== manifest.sourceVersion) return emptyInspection("dirty");
    const files = collectResponseFeedbackCandidateFiles(root);
    const derived = deriveResponseFeedbackCandidate(manifest.baseCommit, manifest.sourceVersion, files);
    if (!sameFiles(manifest.files, files)
      || derived.manifestSha256 !== manifest.manifestSha256
      || derived.candidateBuildId !== manifest.candidateBuildId
      || derived.build !== manifest.build) return emptyInspection("dirty");
    let artifactSha256: string | null = null;
    if (options.requireBuildArtifact) {
      const artifact = inspectResponseFeedbackBuildArtifact(root, manifest.candidateBuildId, manifest.build);
      if (artifact.state !== "known") return emptyInspection(artifact.state);
      artifactSha256 = artifact.artifactSha256;
    }
    return {
      state: "known",
      candidateBuildId: manifest.candidateBuildId,
      build: manifest.build,
      baseCommit: manifest.baseCommit,
      manifestSha256: manifest.manifestSha256,
      artifactSha256,
      sourceVersion: manifest.sourceVersion,
    };
  } catch {
    return emptyInspection("unknown");
  }
}

export function requireKnownResponseFeedbackCandidate(
  options: { root?: string; requireBuildArtifact?: boolean } = {},
): KnownResponseFeedbackCandidate {
  const candidate = process.env.RANGABOT_DESKTOP === "1"
    ? getRuntimeResponseFeedbackCandidate()
    : inspectResponseFeedbackCandidate(options);
  if (candidate.state !== "known" || !candidate.candidateBuildId || !candidate.build
    || !candidate.baseCommit || !candidate.manifestSha256 || !candidate.sourceVersion) {
    throw new Error(`Response Feedback Pulse candidate identity is ${candidate.state}; freeze the exact manifest before building or exporting.`);
  }
  return { ...candidate } as KnownResponseFeedbackCandidate;
}

export function writeResponseFeedbackBuildArtifactManifest(root = process.cwd()) {
  const candidate = requireKnownResponseFeedbackCandidate({ root });
  const files = collectResponseFeedbackBuildArtifactFiles(root);
  const derived = deriveResponseFeedbackBuildArtifact(candidate.candidateBuildId, candidate.build, files);
  const manifest: ResponseFeedbackBuildArtifactManifest = {
    schemaVersion: 1,
    candidateBuildId: candidate.candidateBuildId,
    build: candidate.build,
    artifactSha256: derived.artifactSha256,
    files: derived.files,
  };
  const destination = resolve(root, RESPONSE_FEEDBACK_BUILD_ARTIFACT_PATH);
  const temporary = resolve(dirname(destination), `.rangabot-build-artifact.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, destination);
  return manifest;
}

const runtimeEnvironmentKeys = [
  "RANGABOT_CANDIDATE_STATE",
  "RANGABOT_CANDIDATE_BUILD_ID",
  "RANGABOT_CANDIDATE_BUILD",
  "RANGABOT_CANDIDATE_BASE_COMMIT",
  "RANGABOT_CANDIDATE_MANIFEST_SHA256",
  "RANGABOT_CANDIDATE_ARTIFACT_SHA256",
  "RANGABOT_CANDIDATE_SOURCE_VERSION",
] as const;

export function responseFeedbackCandidateEnvironment(
  environment: Record<string, string | undefined> = process.env,
  options: { requireBuildArtifact?: boolean } = {},
) {
  const next = { ...environment };
  for (const key of runtimeEnvironmentKeys) delete next[key];
  const candidate = inspectResponseFeedbackCandidate({ requireBuildArtifact: options.requireBuildArtifact });
  next.RANGABOT_CANDIDATE_STATE = candidate.state;
  if (candidate.state === "known") {
    next.RANGABOT_CANDIDATE_BUILD_ID = candidate.candidateBuildId ?? undefined;
    next.RANGABOT_CANDIDATE_BUILD = candidate.build ?? undefined;
    next.RANGABOT_CANDIDATE_BASE_COMMIT = candidate.baseCommit ?? undefined;
    next.RANGABOT_CANDIDATE_MANIFEST_SHA256 = candidate.manifestSha256 ?? undefined;
    if (candidate.artifactSha256) next.RANGABOT_CANDIDATE_ARTIFACT_SHA256 = candidate.artifactSha256;
    next.RANGABOT_CANDIDATE_SOURCE_VERSION = candidate.sourceVersion ?? undefined;
  }
  return next;
}

let productionRuntimeCandidate: Readonly<KnownResponseFeedbackCandidate> | undefined;

function runtimeCandidateInspection(
  candidate: ResponseFeedbackCandidateInspection,
  productVersion: string | null = runtimeProductVersion,
): RuntimeResponseFeedbackCandidateInspection {
  return { ...candidate, productVersion };
}

export function getRuntimeResponseFeedbackCandidate(): RuntimeResponseFeedbackCandidateInspection {
  if (process.env.RANGABOT_DESKTOP === "1") {
    try {
      const manifestPath = process.env.RANGABOT_DESKTOP_MANIFEST_PATH;
      const artifactRoot = process.env.RANGABOT_DESKTOP_ARTIFACT_ROOT;
      const expectedManifestPath = runtimeResourcePath("desktop", "manifest.json");
      if (!manifestPath || resolve(manifestPath) !== expectedManifestPath || !artifactRoot) {
        return runtimeCandidateInspection(emptyInspection("unknown"));
      }
      const verified = inspectDesktopArtifact({
        resourceRoot: resolve(artifactRoot),
        manifestPath,
        runtime: desktopRuntimeEvidenceFromResourceRoot({ resourceRoot: runtimePaths.resourceRoot }),
      });
      const inspection: ResponseFeedbackCandidateInspection = {
        state: verified.state,
        candidateBuildId: verified.candidateBuildId,
        build: verified.build,
        baseCommit: verified.baseCommit,
        manifestSha256: verified.manifestSha256,
        artifactSha256: verified.artifactSha256,
        sourceVersion: verified.sourceVersion,
      };
      return runtimeCandidateInspection(inspection, verified.productVersion);
    } catch {
      return runtimeCandidateInspection(emptyInspection("unknown"));
    }
  }
  if (process.env.NODE_ENV === "production" && productionRuntimeCandidate) {
    return runtimeCandidateInspection(productionRuntimeCandidate);
  }
  const state = process.env.RANGABOT_CANDIDATE_STATE;
  const candidateBuildId = process.env.RANGABOT_CANDIDATE_BUILD_ID;
  const build = process.env.RANGABOT_CANDIDATE_BUILD;
  const baseCommit = process.env.RANGABOT_CANDIDATE_BASE_COMMIT;
  const manifestSha256 = process.env.RANGABOT_CANDIDATE_MANIFEST_SHA256;
  const artifactSha256 = process.env.RANGABOT_CANDIDATE_ARTIFACT_SHA256;
  const sourceVersion = process.env.RANGABOT_CANDIDATE_SOURCE_VERSION;
  if (process.env.NODE_ENV === "production" && !artifactSha256) {
    return runtimeCandidateInspection(emptyInspection("unknown"));
  }
  if (state !== "known" || !candidateBuildId || !sha256Pattern.test(candidateBuildId)
    || !build || !buildPattern.test(build) || !baseCommit || !gitCommitPattern.test(baseCommit)
    || !manifestSha256 || !sha256Pattern.test(manifestSha256)
    || (artifactSha256 !== undefined && !sha256Pattern.test(artifactSha256))
    || !sourceVersion || !sourceVersionPattern.test(sourceVersion)) {
    return runtimeCandidateInspection(emptyInspection(
      state === "dirty" || state === "mixed" || state === "unknown" ? state : "unknown",
    ));
  }
  if (process.env.NODE_ENV === "production") {
    productionRuntimeCandidate = Object.freeze({
      state: "known",
      candidateBuildId,
      build,
      baseCommit,
      manifestSha256,
      artifactSha256: artifactSha256 ?? null,
      sourceVersion,
    });
    return runtimeCandidateInspection(productionRuntimeCandidate);
  }
  const verified = inspectResponseFeedbackCandidate({
    requireBuildArtifact: Boolean(artifactSha256),
  });
  if (verified.state !== "known" || verified.candidateBuildId !== candidateBuildId || verified.build !== build
    || verified.baseCommit !== baseCommit || verified.manifestSha256 !== manifestSha256
    || verified.artifactSha256 !== (artifactSha256 ?? null)
    || verified.sourceVersion !== sourceVersion) {
    return runtimeCandidateInspection(emptyInspection(verified.state === "known" ? "mixed" : verified.state));
  }
  return runtimeCandidateInspection(verified);
}

export function responseFeedbackCandidateManifestForTests() {
  return parseManifest(candidateManifest);
}
