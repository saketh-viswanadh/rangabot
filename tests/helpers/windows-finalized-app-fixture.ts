import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DESKTOP_SOURCE_BASE_COMMIT,
  DESKTOP_SOURCE_BASELINE_COMMIT,
  REQUIRED_DESKTOP_FUSE_NAMES,
  REQUIRED_DESKTOP_FUSE_POLICY,
  REQUIRED_DESKTOP_FUSE_WIRE_STATES,
  WINDOWS_DESKTOP_FUSE_BINARY_PATH,
  collectDesktopArtifactFiles,
  collectDesktopBundleFiles,
  createDesktopArtifactManifest,
  deriveDesktopSourceManifestSha256,
  type DesktopArtifactManifestInput,
  type DesktopNativeModuleVersion,
} from "../../lib/desktop-artifact-identity.ts";
import { NORMAL_DESKTOP_LAUNCH_PROFILE } from "../../lib/desktop-launch-profile.ts";

export const SYNTHETIC_WINDOWS_SOURCE_COMMIT = "9".repeat(40);
const sha = (character: string) => character.repeat(64);

function writeFixtureFile(root: string, path: string, content: string | Buffer) {
  const destination = join(root, ...path.split("/"));
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

function syntheticPeX64() {
  const source = Buffer.alloc(192);
  source.writeUInt16LE(0x5a4d, 0);
  source.writeUInt32LE(128, 0x3c);
  source.writeUInt32LE(0x00004550, 128);
  source.writeUInt16LE(0x8664, 132);
  return source;
}

function windowsNativeModules(): DesktopNativeModuleVersion[] {
  return [
    { name: "sqlite-vec", version: "0.1.9" },
    { name: "sqlite-vec-windows-x64", version: "0.1.9" },
    { name: "@duckdb/node-api", version: "1.5.4-r.1" },
    { name: "@duckdb/node-bindings-win32-x64", version: "1.5.4-r.1" },
    { name: "@duckdb/node-bindings", version: "1.5.4-r.1" },
  ];
}

export function createSyntheticFinalizedWindowsApplication(root: string) {
  const appRoot = join(root, "RangaBot-win32-x64");
  const resourceRoot = join(appRoot, "resources");
  const manifestRelativePath = "rangabot-resources/desktop/manifest.json";
  const manifestPath = join(resourceRoot, ...manifestRelativePath.split("/"));
  writeFixtureFile(appRoot, "RangaBot.exe", syntheticPeX64());
  writeFixtureFile(appRoot, "chrome_elf.dll", syntheticPeX64());
  writeFixtureFile(resourceRoot, "app.asar", "compressible synthetic app ".repeat(100));
  writeFixtureFile(resourceRoot, "brand & notes.txt", "ampersand filename fixture\n");
  writeFixtureFile(resourceRoot, "empty.dat", Buffer.alloc(0));
  writeFixtureFile(resourceRoot, "app.asar.unpacked/node_modules/@duckdb/node-bindings-win32-x64/duckdb.node", syntheticPeX64());
  writeFixtureFile(resourceRoot, "app.asar.unpacked/node_modules/@duckdb/node-bindings-win32-x64/duckdb.dll", syntheticPeX64());
  writeFixtureFile(resourceRoot, "app.asar.unpacked/node_modules/sqlite-vec-windows-x64/vec0.dll", syntheticPeX64());
  writeFixtureFile(resourceRoot, "rangabot-resources/runtime/ollama/ollama.exe", syntheticPeX64());
  const resources = collectDesktopArtifactFiles(resourceRoot, [manifestRelativePath]);
  const natives = resources.filter((file) => /\.(?:node|dll|exe)$/iu.test(file.path));
  const bundleFiles = collectDesktopBundleFiles(appRoot, "win32");
  const sourceFiles = [
    { path: "package-lock.json", bytes: 4, sha256: sha("1") },
    { path: "src/app.ts", bytes: 8, sha256: sha("2") },
  ];
  const input: DesktopArtifactManifestInput = {
    sourceBaseCommit: DESKTOP_SOURCE_BASE_COMMIT,
    sourceBaselineCommit: DESKTOP_SOURCE_BASELINE_COMMIT,
    sourceCommit: SYNTHETIC_WINDOWS_SOURCE_COMMIT,
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
      nativeModules: windowsNativeModules(),
    },
    target: { platform: "win32", arch: "x64" },
    fuses: { ...REQUIRED_DESKTOP_FUSE_POLICY },
    packagingTooling: {
      electronForge: "7.11.2",
      electronFuses: "2.1.3",
      fuseWireVersion: "1",
      fuseWireStates: [...REQUIRED_DESKTOP_FUSE_WIRE_STATES],
      fuseInspection: {
        inspectedPath: WINDOWS_DESKTOP_FUSE_BINARY_PATH,
        wireVersion: "1",
        wireLength: 9,
        entries: REQUIRED_DESKTOP_FUSE_NAMES.map((name, index) => ({
          index,
          name,
          expected: REQUIRED_DESKTOP_FUSE_WIRE_STATES[index],
          actual: REQUIRED_DESKTOP_FUSE_WIRE_STATES[index],
        })),
      },
      signature: { mode: "unsigned-candidate", postFuseMutation: true, deepStrictVerified: false },
    },
    bundleFiles,
    resources,
    natives,
    generatedAt: "2026-08-17T00:00:00.000Z",
  };
  const manifest = createDesktopArtifactManifest(input);
  writeFixtureFile(resourceRoot, manifestRelativePath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { appRoot, manifestPath, manifest };
}
