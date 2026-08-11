import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  collectResponseFeedbackCandidateFiles,
  deriveResponseFeedbackCandidate,
  deriveResponseFeedbackBuildArtifact,
  getRuntimeResponseFeedbackCandidate,
  collectResponseFeedbackBuildArtifactFiles,
  inspectResponseFeedbackBuildArtifact,
  inspectResponseFeedbackCandidate,
  responseFeedbackCandidateEnvironment,
  responseFeedbackCandidateManifestForTests,
} from "../lib/response-feedback-candidate.ts";

function createIsolatedCandidateProbeRepository(files: { path: string }[]) {
  const root = mkdtempSync(join(tmpdir(), "rangabot-feedback-candidate-probe-"));
  execFileSync("git", ["clone", "-q", "--shared", "--no-checkout", process.cwd(), root]);
  execFileSync("git", ["checkout", "-q", "--detach", "HEAD"], { cwd: root });
  for (const file of files) {
    const target = join(root, ...file.path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file.path, target);
  }
  return root;
}

test("candidate digest is deterministic over sorted source evidence", () => {
  const files = [
    { path: "z.ts", bytes: 1, sha256: "b".repeat(64) },
    { path: "a.ts", bytes: 2, sha256: "a".repeat(64) },
  ];
  const forward = deriveResponseFeedbackCandidate("1".repeat(40), "0.1.0", files);
  const reverse = deriveResponseFeedbackCandidate("1".repeat(40), "0.1.0", [...files].reverse());
  assert.deepEqual(forward, reverse);
  assert.deepEqual(forward.files.map((file) => file.path), ["a.ts", "z.ts"]);
  assert.match(forward.manifestSha256, /^[0-9a-f]{64}$/);
  assert.match(forward.candidateBuildId, /^[0-9a-f]{64}$/);
  assert.equal(forward.build, `0.1.0+rfp.${forward.candidateBuildId.slice(0, 12)}`);
});

test("the frozen candidate manifest matches every Git-visible file", () => {
  const manifest = responseFeedbackCandidateManifestForTests();
  assert.ok(manifest);
  if (!manifest) return;
  const files = collectResponseFeedbackCandidateFiles();
  const derived = deriveResponseFeedbackCandidate(manifest.baseCommit, manifest.sourceVersion, files);
  assert.deepEqual(manifest.files, derived.files);
  assert.equal(manifest.manifestSha256, derived.manifestSha256);
  assert.equal(manifest.candidateBuildId, derived.candidateBuildId);
  assert.equal(manifest.build, derived.build);
  assert.deepEqual(inspectResponseFeedbackCandidate(), {
    state: "known",
    candidateBuildId: manifest.candidateBuildId,
    build: manifest.build,
    baseCommit: manifest.baseCommit,
    manifestSha256: manifest.manifestSha256,
    artifactSha256: null,
    sourceVersion: manifest.sourceVersion,
  });
});

test("launcher environment discards caller-supplied candidate claims", () => {
  const environment = responseFeedbackCandidateEnvironment({
    RANGABOT_CANDIDATE_STATE: "known",
    RANGABOT_CANDIDATE_BUILD_ID: "f".repeat(64),
    RANGABOT_CANDIDATE_BUILD: "spoofed",
  });
  const manifest = responseFeedbackCandidateManifestForTests();
  assert.equal(environment.RANGABOT_CANDIDATE_BUILD_ID, manifest?.candidateBuildId);
  assert.equal(environment.RANGABOT_CANDIDATE_BUILD, manifest?.build);
});

test("candidate inspection fails closed for dirty, mixed, unknown, and spoofed runtime evidence", () => {
  const manifest = responseFeedbackCandidateManifestForTests();
  assert.ok(manifest);
  if (!manifest) return;

  const dirtyRoot = createIsolatedCandidateProbeRepository(manifest.files);
  const probe = join(dirtyRoot, `.response-feedback-candidate-probe-${process.pid}-${randomUUID()}`);
  try {
    assert.equal(inspectResponseFeedbackCandidate({ root: dirtyRoot }).state, "known");
    writeFileSync(probe, "synthetic untracked source evidence\n");
    assert.equal(inspectResponseFeedbackCandidate({ root: dirtyRoot }).state, "dirty");
    rmSync(probe, { force: true });
    assert.equal(inspectResponseFeedbackCandidate({ root: dirtyRoot }).state, "known");
  } finally {
    rmSync(dirtyRoot, { recursive: true, force: true });
  }
  assert.equal(inspectResponseFeedbackCandidate().state, "known");

  const unrelated = mkdtempSync(join(tmpdir(), "rangabot-feedback-mixed-"));
  try {
    writeFileSync(join(unrelated, "package.json"), JSON.stringify({ version: manifest.sourceVersion }));
    execFileSync("git", ["init", "-q"], { cwd: unrelated });
    execFileSync("git", ["add", "package.json"], { cwd: unrelated });
    execFileSync("git", ["-c", "user.name=Rangabot Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd: unrelated });
    assert.equal(inspectResponseFeedbackCandidate({ root: unrelated }).state, "mixed");
  } finally {
    rmSync(unrelated, { recursive: true, force: true });
  }
  assert.equal(inspectResponseFeedbackCandidate({ root: join(tmpdir(), "missing-rangabot-candidate-root") }).state, "unknown");

  const previous = { ...process.env };
  try {
    Object.assign(process.env, responseFeedbackCandidateEnvironment({}));
    process.env.RANGABOT_CANDIDATE_BUILD_ID = "f".repeat(64);
    assert.equal(getRuntimeResponseFeedbackCandidate().state, "mixed");
    Object.assign(process.env, responseFeedbackCandidateEnvironment({}));
    Reflect.set(process.env, "NODE_ENV", "production");
    delete process.env.RANGABOT_CANDIDATE_ARTIFACT_SHA256;
    assert.equal(getRuntimeResponseFeedbackCandidate().state, "unknown");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

test("build and runtime wiring fail closed around the exact candidate", () => {
  const buildScript = readFileSync("scripts/build.ts", "utf8");
  const devScript = readFileSync("scripts/start-dev.ts", "utf8");
  const startScript = readFileSync("scripts/start-server.ts", "utf8");
  const nextConfig = readFileSync("next.config.ts", "utf8");
  const runtimeRoute = readFileSync("app/api/runtime/candidate/route.ts", "utf8");
  assert.match(buildScript, /requireKnownResponseFeedbackCandidate\(\)/);
  assert.match(nextConfig, /generateBuildId/);
  assert.match(devScript, /responseFeedbackCandidateEnvironment/);
  assert.match(startScript, /requireBuildArtifact: true/);
  assert.match(buildScript, /writeResponseFeedbackBuildArtifactManifest/);
  assert.doesNotMatch(runtimeRoute, /files|path/);
});

test("build artifact digest is deterministic and binds candidate identity", () => {
  const files = [
    { path: "server/b.js", bytes: 2, sha256: "b".repeat(64) },
    { path: "BUILD_ID", bytes: 1, sha256: "a".repeat(64) },
  ];
  const forward = deriveResponseFeedbackBuildArtifact("c".repeat(64), "0.1.0+rfp.abc", files);
  const reverse = deriveResponseFeedbackBuildArtifact("c".repeat(64), "0.1.0+rfp.abc", [...files].reverse());
  assert.deepEqual(forward, reverse);
  assert.match(forward.artifactSha256, /^[0-9a-f]{64}$/);
});

test("build artifact verification rejects changed, missing, and mismatched evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-feedback-artifact-"));
  const candidateBuildId = "c".repeat(64);
  const build = "0.1.0+rfp.abc";
  try {
    mkdirSync(join(root, ".next", "server"), { recursive: true });
    mkdirSync(join(root, "node_modules", "fixture-package"), { recursive: true });
    mkdirSync(join(root, ".next", "node_modules"), { recursive: true });
    writeFileSync(join(root, "node_modules", "fixture-package", "index.js"), "external runtime package\n");
    symlinkSync("../../node_modules/fixture-package", join(root, ".next", "node_modules", "fixture-package-link"));
    writeFileSync(join(root, ".next", "BUILD_ID"), `${build}\n`);
    writeFileSync(join(root, ".next", "server", "app.js"), "verified artifact\n");
    const files = collectResponseFeedbackBuildArtifactFiles(root);
    const derived = deriveResponseFeedbackBuildArtifact(candidateBuildId, build, files);
    const manifest = { schemaVersion: 1, candidateBuildId, build, artifactSha256: derived.artifactSha256, files: derived.files };
    const artifactPath = join(root, ".next", "rangabot-build-artifact.json");
    writeFileSync(artifactPath, JSON.stringify(manifest));
    assert.equal(inspectResponseFeedbackBuildArtifact(root, candidateBuildId, build).state, "known");
    writeFileSync(join(root, "node_modules", "fixture-package", "index.js"), "changed external package\n");
    assert.equal(inspectResponseFeedbackBuildArtifact(root, candidateBuildId, build).state, "mixed");
    writeFileSync(join(root, "node_modules", "fixture-package", "index.js"), "external runtime package\n");
    writeFileSync(join(root, ".next", "server", "app.js"), "changed artifact\n");
    assert.equal(inspectResponseFeedbackBuildArtifact(root, candidateBuildId, build).state, "mixed");
    rmSync(artifactPath);
    assert.equal(inspectResponseFeedbackBuildArtifact(root, candidateBuildId, build).state, "unknown");
    writeFileSync(artifactPath, JSON.stringify(manifest));
    writeFileSync(join(root, ".next", "BUILD_ID"), "another-build\n");
    assert.equal(inspectResponseFeedbackBuildArtifact(root, candidateBuildId, build).state, "mixed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
