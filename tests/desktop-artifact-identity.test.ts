import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createPackage } from "@electron/asar";
import {
  DESKTOP_SOURCE_BASELINE_COMMIT,
  DESKTOP_FUSE_BINARY_PATH,
  REQUIRED_DESKTOP_FUSE_NAMES,
  REQUIRED_DESKTOP_FUSE_POLICY,
  REQUIRED_DESKTOP_FUSE_WIRE_STATES,
  canonicalDesktopArtifactIdentity,
  collectDesktopArtifactFiles,
  collectDesktopBundleFiles,
  createDesktopArtifactManifest,
  deriveDesktopArtifactId,
  deriveDesktopSourceManifestSha256,
  inspectDesktopArtifact,
  parseDesktopArtifactManifest,
  requireKnownDesktopArtifact,
  type DesktopArtifactArch,
  type DesktopArtifactFile,
  type DesktopArtifactManifestInput,
  type DesktopNativeModuleVersion,
  type DesktopRuntimeEvidence,
} from "../lib/desktop-artifact-identity.ts";
import {
  FINDER_VERIFICATION_DESKTOP_LAUNCH_PROFILE,
  NORMAL_DESKTOP_LAUNCH_PROFILE,
} from "../lib/desktop-launch-profile.ts";

const sha = (character: string) => character.repeat(64);
const require = createRequire(import.meta.url);

function nativeModules(arch: DesktopArtifactArch): DesktopNativeModuleVersion[] {
  return [
    { name: "sqlite-vec", version: "0.1.9" },
    { name: `sqlite-vec-darwin-${arch}`, version: "0.1.9" },
    { name: "@duckdb/node-api", version: "1.5.4-r.1" },
    { name: `@duckdb/node-bindings-darwin-${arch}`, version: "1.5.4-r.1" },
    { name: "@duckdb/node-bindings", version: "1.5.4-r.1" },
  ];
}

function runtimeEvidence(arch: DesktopArtifactArch): DesktopRuntimeEvidence {
  return {
    platform: "darwin",
    arch,
    electron: "43.4.0",
    embeddedNode: "24.13.1",
    next: "16.2.12",
    nativeModules: nativeModules(arch),
  };
}

function writeFixtureFile(root: string, path: string, content: string | Buffer) {
  const destination = join(root, ...path.split("/"));
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

function syntheticSignedMachO() {
  const source = Buffer.alloc(80);
  source.writeUInt32LE(0xfeedfacf, 0);
  source.writeUInt32LE(1, 16);
  source.writeUInt32LE(16, 20);
  source.writeUInt32LE(0x1d, 32);
  source.writeUInt32LE(16, 36);
  source.writeUInt32LE(64, 40);
  source.writeUInt32LE(16, 44);
  source.fill(0x43, 48, 64);
  source.fill(0x53, 64, 80);
  return source;
}

function createResourceFixture(arch: DesktopArtifactArch = "arm64") {
  const cleanupRoot = mkdtempSync(join(tmpdir(), "rangabot-desktop-identity-"));
  const contentsRoot = join(cleanupRoot, "Contents");
  const root = join(contentsRoot, "Resources");
  writeFixtureFile(root, "app.asar", "synthetic packaged app\n");
  writeFixtureFile(root, `app.asar.unpacked/node_modules/@duckdb/node-bindings-darwin-${arch}/duckdb.node`, "synthetic DuckDB binding\n");
  writeFixtureFile(root, `app.asar.unpacked/node_modules/@duckdb/node-bindings-darwin-${arch}/libduckdb.dylib`, "synthetic DuckDB library\n");
  writeFixtureFile(root, `app.asar.unpacked/node_modules/sqlite-vec-darwin-${arch}/vec0.dylib`, "synthetic sqlite-vec library\n");
  writeFixtureFile(contentsRoot, "Info.plist", "synthetic plist\n");
  writeFixtureFile(contentsRoot, "MacOS/RangaBot", syntheticSignedMachO());
  writeFixtureFile(contentsRoot, "Frameworks/Electron Framework.framework/Versions/A/Electron Framework", "synthetic fuse-bearing framework\n");
  const resources = collectDesktopArtifactFiles(root);
  const natives = resources.filter((file) => /\.(?:node|dylib)$/.test(file.path));
  const bundleFiles = collectDesktopBundleFiles(contentsRoot);
  return { cleanupRoot, root, contentsRoot, resources, natives, bundleFiles, arch };
}

test("bundle identity binds launcher code without creating a signature-manifest cycle", () => {
  const fixture = createResourceFixture();
  try {
    const launcherPath = join(fixture.contentsRoot, "MacOS", "RangaBot");
    const original = readFileSync(launcherPath);
    const before = collectDesktopBundleFiles(fixture.contentsRoot);
    const signatureChanged = Buffer.from(original);
    signatureChanged[70] ^= 0xff;
    writeFileSync(launcherPath, signatureChanged);
    assert.deepEqual(collectDesktopBundleFiles(fixture.contentsRoot), before);

    const codeChanged = Buffer.from(original);
    codeChanged[50] ^= 0xff;
    writeFileSync(launcherPath, codeChanged);
    assert.notDeepEqual(collectDesktopBundleFiles(fixture.contentsRoot), before);
  } finally {
    rmSync(fixture.cleanupRoot, { recursive: true, force: true });
  }
});

function manifestInput(
  arch: DesktopArtifactArch,
  bundleFiles: DesktopArtifactFile[],
  resources: DesktopArtifactFile[],
  natives: DesktopArtifactFile[],
  overrides: Partial<DesktopArtifactManifestInput> = {},
): DesktopArtifactManifestInput {
  const sourceFiles = [
    { path: "package-lock.json", bytes: 4, sha256: sha("1") },
    { path: "src/app.ts", bytes: 8, sha256: sha("2") },
  ];
  return {
    sourceBaselineCommit: DESKTOP_SOURCE_BASELINE_COMMIT,
    sourceDirty: false,
    sourceManifestSha256: deriveDesktopSourceManifestSha256(sourceFiles),
    sourceFiles,
    packageLockSha256: sha("2"),
    webFeedback: {
      state: "known",
      candidateBuildId: sha("3"),
      build: "0.1.0+rfp.333333333333",
      baseCommit: "4".repeat(40),
      manifestSha256: sha("5"),
      artifactSha256: sha("6"),
      sourceVersion: "0.1.0",
    },
    launchProfile: NORMAL_DESKTOP_LAUNCH_PROFILE,
    runtimeVersions: {
      electron: "43.4.0",
      embeddedNode: "24.13.1",
      next: "16.2.12",
      nativeModules: nativeModules(arch),
    },
    target: { platform: "darwin", arch },
    fuses: { ...REQUIRED_DESKTOP_FUSE_POLICY },
    packagingTooling: {
      electronForge: "7.11.2",
      electronFuses: "2.1.3",
      fuseWireVersion: "1",
      fuseWireStates: [...REQUIRED_DESKTOP_FUSE_WIRE_STATES],
      fuseInspection: {
        inspectedPath: DESKTOP_FUSE_BINARY_PATH,
        wireVersion: "1",
        wireLength: 9,
        entries: REQUIRED_DESKTOP_FUSE_NAMES.map((name, index) => ({
          index,
          name,
          expected: REQUIRED_DESKTOP_FUSE_WIRE_STATES[index],
          actual: REQUIRED_DESKTOP_FUSE_WIRE_STATES[index],
        })),
      },
      signature: {
        mode: "adhoc",
        postFuseMutation: true,
        deepStrictVerified: true,
      },
    },
    bundleFiles,
    resources,
    natives,
    generatedAt: "2026-08-12T04:30:00.000Z",
    ...overrides,
  };
}

test("desktop identity canonicalizes inventories and excludes generatedAt from its digest", () => {
  const fixture = createResourceFixture();
  try {
    const sourceFiles = [
      { path: "z.ts", bytes: 1, sha256: sha("a") },
      { path: "a.ts", bytes: 2, sha256: sha("b") },
    ];
    assert.equal(deriveDesktopSourceManifestSha256(sourceFiles), deriveDesktopSourceManifestSha256([...sourceFiles].reverse()));

    const forward = createDesktopArtifactManifest(manifestInput(fixture.arch, fixture.bundleFiles, fixture.resources, fixture.natives));
    const reverse = createDesktopArtifactManifest(manifestInput(
      fixture.arch,
      fixture.bundleFiles,
      [...fixture.resources].reverse(),
      [...fixture.natives].reverse(),
      {
        generatedAt: "2026-08-12T05:30:00.000Z",
        runtimeVersions: {
          electron: "43.4.0",
          embeddedNode: "24.13.1",
          next: "16.2.12",
          nativeModules: [...nativeModules(fixture.arch)].reverse(),
        },
      },
    ));
    assert.equal(forward.desktopArtifactId, reverse.desktopArtifactId);
    assert.equal(forward.resourceManifestSha256, reverse.resourceManifestSha256);
    assert.equal(forward.nativeManifestSha256, reverse.nativeManifestSha256);
    assert.equal(deriveDesktopArtifactId(forward), forward.desktopArtifactId);
    assert.equal(canonicalDesktopArtifactIdentity(forward), canonicalDesktopArtifactIdentity(reverse));
    assert.doesNotMatch(canonicalDesktopArtifactIdentity(forward), /generatedAt/);
    assert.deepEqual(forward.resources.map((file) => file.path), [...forward.resources.map((file) => file.path)].sort());
    assert.deepEqual(parseDesktopArtifactManifest(JSON.parse(JSON.stringify(forward))), forward);
  } finally {
    rmSync(fixture.cleanupRoot, { recursive: true, force: true });
  }
});

test("installed verification rejects staging manifests without post-fuse ad-hoc signature proof", () => {
  const fixture = createResourceFixture();
  const manifestPath = join(fixture.root, "rangabot-desktop-artifact.json");
  try {
    const input = manifestInput(fixture.arch, fixture.bundleFiles, fixture.resources, fixture.natives);
    const manifest = createDesktopArtifactManifest({
      ...input,
      packagingTooling: {
        ...input.packagingTooling,
        signature: {
          mode: "adhoc",
          postFuseMutation: false,
          deepStrictVerified: false,
        },
      },
    });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const verified = inspectDesktopArtifact({
      resourceRoot: fixture.root,
      manifestPath,
      runtime: runtimeEvidence(fixture.arch),
    });
    assert.equal(verified.state, "unknown");
    assert.equal(verified.reason, "manifest-invalid");
  } finally {
    rmSync(fixture.cleanupRoot, { recursive: true, force: true });
  }
});

test("installed verification is known without Git or cwd discovery and exposes a compatible arch-bound build identity", () => {
  const fixture = createResourceFixture();
  const manifestPath = join(fixture.root, "rangabot-desktop-artifact.json");
  try {
    const manifest = createDesktopArtifactManifest(manifestInput(fixture.arch, fixture.bundleFiles, fixture.resources, fixture.natives));
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const verified = inspectDesktopArtifact({
      resourceRoot: fixture.root,
      manifestPath,
      runtime: runtimeEvidence(fixture.arch),
    });
    assert.equal(verified.state, "known");
    assert.equal(verified.reason, "known");
    assert.equal(verified.candidateBuildId, manifest.desktopArtifactId);
    assert.equal(verified.artifactSha256, manifest.desktopArtifactId);
    assert.equal(verified.manifestSha256, manifest.sourceManifestSha256);
    assert.equal(verified.baseCommit, DESKTOP_SOURCE_BASELINE_COMMIT);
    assert.equal(verified.build, `0.1.0+desktop.${fixture.arch}.${manifest.desktopArtifactId.slice(0, 12)}`);
    assert.deepEqual(requireKnownDesktopArtifact({
      resourceRoot: fixture.root,
      manifestPath,
      runtime: runtimeEvidence(fixture.arch),
    }).manifest, verified.manifest);
    assert.equal(inspectDesktopArtifact({
      resourceRoot: "relative/resources",
      manifestPath,
      runtime: runtimeEvidence(fixture.arch),
    }).state, "unknown");
  } finally {
    rmSync(fixture.cleanupRoot, { recursive: true, force: true });
  }
});

test("x64 identities accept only the independently inventoried x64 native chain", () => {
  const fixture = createResourceFixture("x64");
  const manifestPath = join(fixture.root, "rangabot-desktop-artifact.json");
  try {
    const manifest = createDesktopArtifactManifest(manifestInput(fixture.arch, fixture.bundleFiles, fixture.resources, fixture.natives));
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const verified = inspectDesktopArtifact({ resourceRoot: fixture.root, manifestPath, runtime: runtimeEvidence("x64") });
    assert.equal(verified.state, "known");
    assert.match(verified.build ?? "", /\+desktop\.x64\.[0-9a-f]{12}$/);
    assert.equal(inspectDesktopArtifact({
      resourceRoot: fixture.root,
      manifestPath,
      runtime: runtimeEvidence("arm64"),
    }).reason, "runtime-mismatch");
  } finally {
    rmSync(fixture.cleanupRoot, { recursive: true, force: true });
  }
});

test("runtime verification rejects dirty source and wrong runtime architecture or versions", () => {
  const fixture = createResourceFixture();
  const manifestPath = join(fixture.root, "rangabot-desktop-artifact.json");
  try {
    const clean = createDesktopArtifactManifest(manifestInput(fixture.arch, fixture.bundleFiles, fixture.resources, fixture.natives));
    writeFileSync(manifestPath, JSON.stringify(clean));
    assert.equal(inspectDesktopArtifact({
      resourceRoot: fixture.root,
      manifestPath,
      runtime: { ...runtimeEvidence(fixture.arch), arch: "x64" },
    }).reason, "runtime-mismatch");
    assert.equal(inspectDesktopArtifact({
      resourceRoot: fixture.root,
      manifestPath,
      runtime: { ...runtimeEvidence(fixture.arch), electron: "43.3.0" },
    }).state, "mixed");

    const dirty = createDesktopArtifactManifest(manifestInput(fixture.arch, fixture.bundleFiles, fixture.resources, fixture.natives, { sourceDirty: true }));
    writeFileSync(manifestPath, JSON.stringify(dirty));
    const rejected = inspectDesktopArtifact({ resourceRoot: fixture.root, manifestPath, runtime: runtimeEvidence(fixture.arch) });
    assert.equal(rejected.state, "dirty");
    assert.equal(rejected.reason, "source-dirty");
    assert.throws(
      () => requireKnownDesktopArtifact({ resourceRoot: fixture.root, manifestPath, runtime: runtimeEvidence(fixture.arch) }),
      /Desktop artifact identity is dirty/,
    );
  } finally {
    rmSync(fixture.cleanupRoot, { recursive: true, force: true });
  }
});

test("runtime verification rejects tampered, missing, extra, and symbolic-link resources", () => {
  const fixture = createResourceFixture();
  const manifestPath = join(fixture.root, "rangabot-desktop-artifact.json");
  const appAsar = join(fixture.root, "app.asar");
  try {
    const manifest = createDesktopArtifactManifest(manifestInput(fixture.arch, fixture.bundleFiles, fixture.resources, fixture.natives));
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const verify = () => inspectDesktopArtifact({ resourceRoot: fixture.root, manifestPath, runtime: runtimeEvidence(fixture.arch) });
    assert.equal(verify().state, "known");

    writeFileSync(appAsar, "tampered packaged app\n");
    assert.equal(verify().reason, "resource-mismatch");
    writeFileSync(appAsar, "synthetic packaged app\n");
    assert.equal(verify().state, "known");

    const framework = join(fixture.contentsRoot, ...DESKTOP_FUSE_BINARY_PATH.split("/"));
    writeFileSync(framework, "tampered fuse-bearing framework\n");
    assert.equal(verify().reason, "resource-mismatch");
    writeFileSync(framework, "synthetic fuse-bearing framework\n");
    assert.equal(verify().state, "known");

    rmSync(appAsar);
    assert.equal(verify().state, "mixed");
    writeFileSync(appAsar, "synthetic packaged app\n");
    writeFileSync(join(fixture.root, "unexpected.txt"), "extra controlled resource\n");
    assert.equal(verify().state, "mixed");
    rmSync(join(fixture.root, "unexpected.txt"));

    symlinkSync(appAsar, join(fixture.root, "unexpected-link"));
    assert.equal(verify().reason, "resource-mismatch");
  } finally {
    rmSync(fixture.cleanupRoot, { recursive: true, force: true });
  }
});

test("manifest creation and parsing reject unsafe, duplicate, incomplete, and mixed native inventories", () => {
  const fixture = createResourceFixture();
  try {
    assert.throws(
      () => createDesktopArtifactManifest(manifestInput(fixture.arch, fixture.bundleFiles, [...fixture.resources, fixture.resources[0]], fixture.natives)),
      /unique safe relative paths/,
    );
    assert.throws(
      () => createDesktopArtifactManifest(manifestInput(fixture.arch, fixture.bundleFiles, fixture.resources, fixture.natives.slice(1))),
      /native payload inventory/i,
    );
    assert.throws(
      () => createDesktopArtifactManifest(manifestInput(fixture.arch, fixture.bundleFiles, fixture.resources, fixture.natives, {
        sourceBaselineCommit: "0".repeat(40),
      })),
      new RegExp(DESKTOP_SOURCE_BASELINE_COMMIT),
    );

    const valid = createDesktopArtifactManifest(manifestInput(fixture.arch, fixture.bundleFiles, fixture.resources, fixture.natives));
    const unsafe = JSON.parse(JSON.stringify(valid)) as Record<string, unknown> & { resources: Array<Record<string, unknown>> };
    unsafe.resources[0].path = "../escape";
    assert.equal(parseDesktopArtifactManifest(unsafe), null);
    const duplicate = JSON.parse(JSON.stringify(valid)) as Record<string, unknown> & { resources: Array<Record<string, unknown>> };
    duplicate.resources[1].path = duplicate.resources[0].path;
    assert.equal(parseDesktopArtifactManifest(duplicate), null);
    const wrongIdentity = { ...valid, desktopArtifactId: sha("f") };
    assert.equal(parseDesktopArtifactManifest(wrongIdentity), null);
  } finally {
    rmSync(fixture.cleanupRoot, { recursive: true, force: true });
  }
});

test("the sealed Finder verification profile changes artifact identity and is arm64-only", () => {
  const fixture = createResourceFixture("arm64");
  const x64 = createResourceFixture("x64");
  try {
    const normal = createDesktopArtifactManifest(manifestInput(fixture.arch, fixture.bundleFiles, fixture.resources, fixture.natives));
    const verification = createDesktopArtifactManifest(manifestInput(
      fixture.arch,
      fixture.bundleFiles,
      fixture.resources,
      fixture.natives,
      { launchProfile: FINDER_VERIFICATION_DESKTOP_LAUNCH_PROFILE },
    ));
    assert.notEqual(normal.desktopArtifactId, verification.desktopArtifactId);
    assert.deepEqual(parseDesktopArtifactManifest(JSON.parse(JSON.stringify(verification)))?.launchProfile,
      FINDER_VERIFICATION_DESKTOP_LAUNCH_PROFILE);
    assert.throws(() => createDesktopArtifactManifest(manifestInput(x64.arch, x64.bundleFiles, x64.resources, x64.natives,
      { launchProfile: FINDER_VERIFICATION_DESKTOP_LAUNCH_PROFILE })), /launch profile/i);
  } finally {
    rmSync(fixture.cleanupRoot, { recursive: true, force: true });
    rmSync(x64.cleanupRoot, { recursive: true, force: true });
  }
});

test("runtime identity implementation has no Git, cwd, or automatic write dependency", () => {
  const source = readFileSync(new URL("../lib/desktop-artifact-identity.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|\bexecFile|\bspawn|process\.cwd\s*\(/);
  assert.doesNotMatch(source, /writeFile|renameSync|copyFile/);
  assert.doesNotMatch(source, /["']git["']/);
});

test("Electron inventories app.asar as one raw file instead of virtual ASAR contents", async () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-electron-raw-asar-"));
  const source = join(root, "source");
  const resources = join(root, "resources");
  mkdirSync(source);
  mkdirSync(resources);
  writeFileSync(join(source, "package.json"), JSON.stringify({ main: "main.js" }));
  writeFileSync(join(source, "main.js"), "module.exports = true;\n");
  try {
    await createPackage(source, join(resources, "app.asar"));
    const electron = require("electron") as string;
    const fixture = join(process.cwd(), "tests", "fixtures", "desktop-electron-raw-asar-check.ts");
    const result = spawnSync(electron, ["--experimental-strip-types", fixture, resources], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout.trim()).path, "app.asar");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
