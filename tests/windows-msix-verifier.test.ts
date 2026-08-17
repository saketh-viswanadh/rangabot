import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { constants as zlibConstants, crc32, deflateRawSync } from "node:zlib";
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
} from "../lib/desktop-artifact-identity.ts";
import { NORMAL_DESKTOP_LAUNCH_PROFILE } from "../lib/desktop-launch-profile.ts";
import { collectMsixSourceInventory } from "../lib/windows-msix.ts";
import {
  parseAppxBlockMap,
  parseMsixContentTypes,
  verifyUnsignedMsix,
} from "../lib/windows-msix-verifier.ts";

type FixtureZipEntry = Readonly<{ name: string; content: Buffer; compressed?: boolean }>;

const projectRoot = resolve(import.meta.dirname, "..");
const msixRoot = join(projectRoot, "desktop", "msix");
const sourceCommit = "9".repeat(40);
const sha = (character: string) => character.repeat(64);

function temporaryDirectory() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "rangabot-msix-verifier-test-"));
  test.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

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

function createSyntheticFinalizedApplication(root: string) {
  const appRoot = join(root, "RangaBot-win32-x64");
  const resourceRoot = join(appRoot, "resources");
  const manifestRelativePath = "rangabot-resources/desktop/manifest.json";
  const manifestPath = join(resourceRoot, ...manifestRelativePath.split("/"));
  writeFixtureFile(appRoot, "RangaBot.exe", syntheticPeX64());
  writeFixtureFile(appRoot, "chrome_elf.dll", syntheticPeX64());
  writeFixtureFile(resourceRoot, "app.asar", "compressible synthetic app ".repeat(100));
  writeFixtureFile(resourceRoot, "brand & notes.txt", "ampersand filename fixture\n");
  writeFixtureFile(resourceRoot, "chunks/chunk[1]%5B.js", "canonical MakeAppx path fixture\n");
  writeFixtureFile(resourceRoot, "chunks/multiblock.dat", Buffer.from(
    Array.from({ length: 70_000 }, (_, index) => String.fromCharCode(32 + (index * 17) % 90)).join(""),
    "ascii",
  ));
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
    sourceCommit,
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

function makeAppxDeflate(content: Buffer) {
  const segments: Buffer[] = [];
  const compressedBlockBytes: number[] = [];
  for (let offset = 0; offset < content.length; offset += 65_536) {
    const segment = deflateRawSync(content.subarray(offset, offset + 65_536), {
      flush: zlibConstants.Z_SYNC_FLUSH,
      finishFlush: zlibConstants.Z_SYNC_FLUSH,
    });
    segments.push(segment);
    compressedBlockBytes.push(segment.length);
  }
  return Object.freeze({
    body: Buffer.concat([...segments, Buffer.from([0x03, 0x00])]),
    compressedBlockBytes: Object.freeze(compressedBlockBytes),
  });
}

function prepareZipEntry(entry: FixtureZipEntry) {
  const compressed = entry.compressed ? makeAppxDeflate(entry.content) : null;
  return Object.freeze({
    ...entry,
    body: compressed?.body ?? entry.content,
    compressedBlockBytes: compressed?.compressedBlockBytes ?? Object.freeze([]),
    method: entry.compressed ? 8 : 0,
    crc: crc32(entry.content),
  });
}

function encodeMakeAppxFixtureName(packagePath: string) {
  if (packagePath === "[Content_Types].xml") return packagePath;
  return [...Buffer.from(packagePath, "utf8")].map((byte) => {
    if ((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)
      || (byte >= 0x30 && byte <= 0x39) || byte === 0x2d || byte === 0x2e
      || byte === 0x5f || byte === 0x7e || byte === 0x2f) return String.fromCharCode(byte);
    return `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
}

function createZip(entriesInput: readonly FixtureZipEntry[]) {
  const entries = entriesInput.map(prepareZipEntry);
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(encodeMakeAppxFixtureName(entry.name), "ascii");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(45, 4);
    local.writeUInt16LE(0x0008, 6);
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt16LE(name.length, 26);
    const descriptor = Buffer.alloc(24);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(entry.crc, 4);
    descriptor.writeBigUInt64LE(BigInt(entry.body.length), 8);
    descriptor.writeBigUInt64LE(BigInt(entry.content.length), 16);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(45, 4);
    central.writeUInt16LE(45, 6);
    central.writeUInt16LE(0x0008, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt32LE(entry.crc, 16);
    central.writeUInt32LE(0xffffffff, 20);
    central.writeUInt32LE(0xffffffff, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(28, 30);
    central.writeUInt32LE(0xffffffff, 42);
    const extra = Buffer.alloc(28);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(24, 2);
    extra.writeBigUInt64LE(BigInt(entry.content.length), 4);
    extra.writeBigUInt64LE(BigInt(entry.body.length), 12);
    extra.writeBigUInt64LE(BigInt(localOffset), 20);
    localParts.push(local, name, entry.body, descriptor);
    centralParts.push(central, name, extra);
    localOffset += local.length + name.length + entry.body.length + descriptor.length;
  }
  const central = Buffer.concat(centralParts);
  const zip64Offset = localOffset + central.length;
  const zip64End = Buffer.alloc(56);
  zip64End.writeUInt32LE(0x06064b50, 0);
  zip64End.writeBigUInt64LE(BigInt(44), 4);
  zip64End.writeUInt16LE(45, 12);
  zip64End.writeUInt16LE(45, 14);
  zip64End.writeBigUInt64LE(BigInt(entries.length), 24);
  zip64End.writeBigUInt64LE(BigInt(entries.length), 32);
  zip64End.writeBigUInt64LE(BigInt(central.length), 40);
  zip64End.writeBigUInt64LE(BigInt(localOffset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(zip64Offset), 8);
  locator.writeUInt32LE(1, 16);
  const classicEnd = Buffer.alloc(22, 0xff);
  classicEnd.writeUInt32LE(0x06054b50, 0);
  classicEnd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, central, zip64End, locator, classicEnd]);
}

function xmlAttribute(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function blockHashes(content: Buffer) {
  const output: string[] = [];
  for (let offset = 0; offset < content.length; offset += 65_536) {
    output.push(createHash("sha256").update(content.subarray(offset, offset + 65_536)).digest("base64"));
  }
  return output;
}

type BlockMapMutation = "none" | "bad-hash" | "stored-size" | "compressed-size-missing"
  | "compressed-size-with-wrapper" | "compressed-boundary-redistributed";

function createBlockMap(sources: readonly FixtureZipEntry[], mutation: BlockMapMutation) {
  let changed = false;
  const files = sources.map((source) => {
    const blockMapName = source.name.replaceAll("/", "\\");
    const nameBytes = Buffer.byteLength(encodeMakeAppxFixtureName(source.name), "ascii");
    if (source.content.length === 0) {
      return `  <File Name="${xmlAttribute(blockMapName)}" Size="0" LfhSize="${30 + nameBytes}" />`;
    }
    const compressed = source.compressed ? makeAppxDeflate(source.content) : null;
    const hashes = blockHashes(source.content);
    const compressedBlockBytes = [...(compressed?.compressedBlockBytes ?? [])];
    if (!changed && mutation === "compressed-boundary-redistributed" && compressedBlockBytes.length > 1) {
      compressedBlockBytes[0] += 1;
      compressedBlockBytes[1] -= 1;
      changed = true;
    }
    const blocks = hashes.map((hash, index) => {
      let outputHash = hash;
      let size = source.compressed ? ` Size="${compressedBlockBytes[index]}"` : "";
      if (!changed && mutation === "bad-hash") {
        outputHash = Buffer.alloc(32, 0xa5).toString("base64");
        changed = true;
      } else if (!changed && mutation === "stored-size" && !source.compressed) {
        size = ` Size="${source.content.length}"`;
        changed = true;
      } else if (!changed && mutation === "compressed-size-missing" && source.compressed) {
        size = "";
        changed = true;
      } else if (!changed && mutation === "compressed-size-with-wrapper" && source.compressed) {
        size = ` Size="${(compressedBlockBytes[index] ?? 0) + 2}"`;
        changed = true;
      }
      return `    <Block Hash="${outputHash}"${size}/>`;
    }).join("\n");
    return `  <File Name="${xmlAttribute(blockMapName)}" Size="${source.content.length}" LfhSize="${30 + nameBytes}">\n${blocks}\n  </File>`;
  }).join("\n");
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<BlockMap HashMethod="http://www.w3.org/2001/04/xmlenc#sha256" xmlns="http://schemas.microsoft.com/appx/2010/blockmap">\n${files}\n</BlockMap>\n`, "utf8");
}

function contentTypePartName(packagePath: string) {
  return `/${packagePath.split("/").map((component) => encodeURIComponent(component)).join("/")}`;
}

function createContentTypes(
  packagePaths: readonly string[],
  manifestResolution: "override" | "default" = "override",
) {
  const defaults = new Set<string>();
  const genericOverrides: string[] = [];
  for (const packagePath of packagePaths) {
    if (packagePath === "[Content_Types].xml" || packagePath === "AppxManifest.xml"
      || packagePath === "AppxBlockMap.xml") continue;
    const name = packagePath.slice(packagePath.lastIndexOf("/") + 1);
    const dot = name.lastIndexOf(".");
    if (dot > 0 && dot < name.length - 1) defaults.add(name.slice(dot + 1).toLocaleLowerCase("en-US"));
    else genericOverrides.push(`  <Override PartName="${xmlAttribute(contentTypePartName(packagePath))}" ContentType="application/octet-stream"/>`);
  }
  const declarations = [
    ...[...defaults].sort().map((extension) => `  <Default Extension="${extension}" ContentType="${manifestResolution === "default" && extension === "xml" ? "application/vnd.ms-appx.manifest+xml" : "application/octet-stream"}"/>`),
    ...(manifestResolution === "default" && !defaults.has("xml")
      ? ["  <Default Extension=\"xml\" ContentType=\"application/vnd.ms-appx.manifest+xml\"/>"]
      : []),
    ...genericOverrides,
    ...(manifestResolution === "override"
      ? ["  <Override PartName=\"/AppxManifest.xml\" ContentType=\"application/vnd.ms-appx.manifest+xml\"/>"]
      : []),
    "  <Override PartName=\"/AppxBlockMap.xml\" ContentType=\"application/vnd.ms-appx.blockmap+xml\"/>",
  ];
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n${declarations.join("\n")}\n</Types>\n`, "utf8");
}

function writeSyntheticMsix(input: Readonly<{
  root: string;
  appRoot: string;
  mutation?: BlockMapMutation;
}>) {
  const inventory = collectMsixSourceInventory({
    applicationRoot: input.appRoot,
    manifestPath: join(msixRoot, "AppxManifest.xml"),
    assetsRoot: join(msixRoot, "assets"),
  });
  const sources: FixtureZipEntry[] = inventory.map((entry) => Object.freeze({
    name: entry.packagePath,
    content: readFileSync(entry.sourcePath),
    compressed: entry.packagePath === "resources/app.asar"
      || entry.packagePath === "resources/chunks/multiblock.dat",
  }));
  const blockMap = createBlockMap(sources, input.mutation ?? "none");
  const packagePaths = [...sources.map((source) => source.name), "AppxBlockMap.xml", "[Content_Types].xml"];
  const path = join(input.root, `candidate-${input.mutation ?? "none"}.msix`);
  writeFileSync(path, createZip([
    ...sources,
    { name: "AppxBlockMap.xml", content: blockMap },
    { name: "[Content_Types].xml", content: createContentTypes(packagePaths, "default") },
  ]));
  return path;
}

const contentTypeFixturePaths = Object.freeze([
  "AppxManifest.xml",
  "AppxBlockMap.xml",
  "RangaBot.exe",
  "assets/logo.png",
  "resources/read me & notes.txt",
  "LICENSE",
  "[Content_Types].xml",
]);

test("content types parser accepts one safe OPC inventory with exact required overrides", () => {
  const parsed = parseMsixContentTypes(createContentTypes(contentTypeFixturePaths), contentTypeFixturePaths);
  assert.equal(parsed.namespace, "http://schemas.openxmlformats.org/package/2006/content-types");
  assert.equal(parsed.overrides.find((entry) => entry.packagePath === "AppxManifest.xml")?.contentType,
    "application/vnd.ms-appx.manifest+xml");
  assert.equal(parsed.overrides.find((entry) => entry.packagePath === "AppxBlockMap.xml")?.contentType,
    "application/vnd.ms-appx.blockmap+xml");
  assert.ok(parsed.defaults.some((entry) => entry.extension === "exe"));
  assert.ok(parsed.overrides.some((entry) => entry.packagePath === "LICENSE"));
});

test("content types parser accepts the exact MakeAppx manifest XML Default when no payload XML exists", () => {
  const parsed = parseMsixContentTypes(
    createContentTypes(contentTypeFixturePaths, "default"),
    contentTypeFixturePaths,
  );
  assert.equal(parsed.defaults.find((entry) => entry.extension === "xml")?.contentType,
    "application/vnd.ms-appx.manifest+xml");
  assert.equal(parsed.overrides.some((entry) => entry.packagePath === "AppxManifest.xml"), false);
  assert.equal(parsed.overrides.find((entry) => entry.packagePath === "AppxBlockMap.xml")?.contentType,
    "application/vnd.ms-appx.blockmap+xml");
});

test("content types parser keeps the exact manifest Override profile compatible with payload XML", () => {
  const paths = [...contentTypeFixturePaths, "resources/payload.xml"];
  const parsed = parseMsixContentTypes(createContentTypes(paths), paths);
  assert.equal(parsed.overrides.find((entry) => entry.packagePath === "AppxManifest.xml")?.contentType,
    "application/vnd.ms-appx.manifest+xml");
  assert.equal(parsed.defaults.find((entry) => entry.extension === "xml")?.contentType,
    "application/octet-stream");
});

test("content types parser rejects malformed or non-UTF-8 XML and a wrong namespace", () => {
  const valid = createContentTypes(contentTypeFixturePaths).toString("utf8");
  assert.throws(() => parseMsixContentTypes(Buffer.from([0xff]), contentTypeFixturePaths), /UTF-8/u);
  assert.throws(() => parseMsixContentTypes(
    Buffer.from(valid.replace("<Default Extension=\"exe\" ContentType=\"application/octet-stream\"/>",
      "<Default Extension=\"exe\" ContentType=\"application/octet-stream\"></Default>")),
    contentTypeFixturePaths,
  ), /unexpected content/u);
  assert.throws(() => parseMsixContentTypes(
    Buffer.from(valid.replace("http://schemas.openxmlformats.org/package/2006/content-types", "urn:wrong")),
    contentTypeFixturePaths,
  ), /namespace/u);
});

test("content types parser rejects signature or catalog declarations", () => {
  const valid = createContentTypes(contentTypeFixturePaths).toString("utf8");
  const signature = valid.replace("</Types>",
    "  <Default Extension=\"p7x\" ContentType=\"application/vnd.ms-appx.signature\"/>\n</Types>");
  const catalog = valid.replace("</Types>",
    "  <Default Extension=\"cat\" ContentType=\"application/vnd.ms-pkiseccat\"/>\n</Types>");
  assert.throws(() => parseMsixContentTypes(Buffer.from(signature), contentTypeFixturePaths), /signature or catalog/u);
  assert.throws(() => parseMsixContentTypes(Buffer.from(catalog), contentTypeFixturePaths), /signature or catalog/u);
});

test("content types parser requires exact manifest resolution and blockmap override and rejects unknown parts", () => {
  const valid = createContentTypes(contentTypeFixturePaths).toString("utf8");
  const missingBlockMap = valid.replace(
    "  <Override PartName=\"/AppxBlockMap.xml\" ContentType=\"application/vnd.ms-appx.blockmap+xml\"/>\n",
    "",
  );
  const wrongManifestType = valid.replace(
    "application/vnd.ms-appx.manifest+xml",
    "application/octet-stream",
  );
  const unknownPart = valid.replace("</Types>",
    "  <Override PartName=\"/ghost.dll\" ContentType=\"application/octet-stream\"/>\n</Types>");
  assert.throws(() => parseMsixContentTypes(Buffer.from(missingBlockMap), contentTypeFixturePaths), /AppxBlockMap\.xml Override/u);
  assert.throws(() => parseMsixContentTypes(Buffer.from(wrongManifestType), contentTypeFixturePaths), /AppxManifest\.xml Override/u);
  assert.throws(() => parseMsixContentTypes(Buffer.from(unknownPart), contentTypeFixturePaths), /exact package part/u);
});

test("content types parser rejects unsafe manifest XML Default variants", () => {
  const exactDefault = createContentTypes(contentTypeFixturePaths, "default").toString("utf8");
  const payloadXmlPaths = [...contentTypeFixturePaths, "resources/payload.xml"];
  const payloadXml = createContentTypes(payloadXmlPaths, "default");
  const explicitlyOverriddenPayloadXml = Buffer.from(payloadXml.toString("utf8").replace(
    "</Types>",
    "  <Override PartName=\"/resources/payload.xml\" ContentType=\"application/octet-stream\"/>\n</Types>",
  ));
  const missingManifestPaths = contentTypeFixturePaths.filter((entry) => entry !== "AppxManifest.xml");
  const miscasedManifestPaths = contentTypeFixturePaths.map((entry) => entry === "AppxManifest.xml"
    ? "AppxManifest.XML"
    : entry);
  const wrongCase = exactDefault.replace('Extension="xml"', 'Extension="XML"');
  const wrongType = exactDefault.replace(
    "application/vnd.ms-appx.manifest+xml",
    "application/octet-stream",
  );
  const redundant = createContentTypes(contentTypeFixturePaths).toString("utf8").replace(
    "</Types>",
    "  <Default Extension=\"xml\" ContentType=\"application/vnd.ms-appx.manifest+xml\"/>\n</Types>",
  );
  const wrongManifestOverride = exactDefault.replace(
    "</Types>",
    "  <Override PartName=\"/AppxManifest.xml\" ContentType=\"application/octet-stream\"/>\n</Types>",
  );
  const otherManifestClaim = exactDefault.replace(
    "</Types>",
    "  <Default Extension=\"foo\" ContentType=\"application/vnd.ms-appx.manifest+xml\"/>\n</Types>",
  );
  const mixedCaseManifestClaim = exactDefault.replace(
    "</Types>",
    "  <Default Extension=\"foo\" ContentType=\"Application/Vnd.Ms-Appx.Manifest+Xml\"/>\n</Types>",
  );
  const mixedCaseBlockMapClaim = exactDefault.replace(
    "</Types>",
    "  <Default Extension=\"foo\" ContentType=\"Application/Vnd.Ms-Appx.BlockMap+Xml\"/>\n</Types>",
  );
  assert.throws(() => parseMsixContentTypes(payloadXml, payloadXmlPaths), /no payload XML/u);
  assert.throws(() => parseMsixContentTypes(explicitlyOverriddenPayloadXml, payloadXmlPaths), /no payload XML/u);
  assert.throws(() => parseMsixContentTypes(
    createContentTypes(missingManifestPaths, "default"),
    missingManifestPaths,
  ), /no payload XML/u);
  assert.throws(() => parseMsixContentTypes(
    createContentTypes(miscasedManifestPaths, "default"),
    miscasedManifestPaths,
  ), /no payload XML/u);
  assert.throws(() => parseMsixContentTypes(Buffer.from(wrongCase), contentTypeFixturePaths), /resolve AppxManifest/u);
  assert.throws(() => parseMsixContentTypes(Buffer.from(wrongType), contentTypeFixturePaths), /resolve AppxManifest/u);
  assert.throws(() => parseMsixContentTypes(Buffer.from(redundant), contentTypeFixturePaths), /ambiguous manifest/u);
  assert.throws(() => parseMsixContentTypes(Buffer.from(wrongManifestOverride), contentTypeFixturePaths), /invalid AppxManifest/u);
  assert.throws(() => parseMsixContentTypes(Buffer.from(otherManifestClaim), contentTypeFixturePaths), /ambiguous manifest/u);
  assert.throws(() => parseMsixContentTypes(Buffer.from(mixedCaseManifestClaim), contentTypeFixturePaths), /ambiguous manifest/u);
  assert.throws(() => parseMsixContentTypes(Buffer.from(mixedCaseBlockMapClaim), contentTypeFixturePaths), /ambiguous block-map/u);
});

test("content types parser rejects duplicate declarations and uncovered package parts", () => {
  const valid = createContentTypes(contentTypeFixturePaths).toString("utf8");
  const duplicateDefault = valid.replace("</Types>",
    "  <Default Extension=\"EXE\" ContentType=\"application/octet-stream\"/>\n</Types>");
  const duplicateOverride = valid.replace("</Types>",
    "  <Override PartName=\"/appxmanifest.xml\" ContentType=\"application/vnd.ms-appx.manifest+xml\"/>\n</Types>");
  const uncovered = valid.replace(
    "  <Default Extension=\"png\" ContentType=\"application/octet-stream\"/>\n",
    "",
  );
  assert.throws(() => parseMsixContentTypes(Buffer.from(duplicateDefault), contentTypeFixturePaths), /repeats Default/u);
  assert.throws(() => parseMsixContentTypes(Buffer.from(duplicateOverride), contentTypeFixturePaths), /repeats Override/u);
  assert.throws(() => parseMsixContentTypes(Buffer.from(uncovered), contentTypeFixturePaths), /does not cover/u);
});

test("block map parser accepts only the exact optional MakeAppx standalone declaration", () => {
  const fixture = createBlockMap([{
    name: "fixture.txt",
    content: Buffer.from("fixture"),
  }], "none");
  assert.equal(parseAppxBlockMap(fixture).length, 1);
  assert.throws(() => parseAppxBlockMap(Buffer.from(
    fixture.toString("utf8").replace('standalone="no"', 'standalone="yes"'),
  )), /exact BlockMap root/u);
});

test("full verifier reconciles every stored/compressed/empty source with AppxBlockMap SHA-256", async () => {
  const root = temporaryDirectory();
  const application = createSyntheticFinalizedApplication(root);
  const msixPath = writeSyntheticMsix({ root, appRoot: application.appRoot });
  const result = await verifyUnsignedMsix({
    msixPath,
    applicationRoot: application.appRoot,
    manifestPath: join(msixRoot, "AppxManifest.xml"),
    assetsRoot: join(msixRoot, "assets"),
    checkedOutCommit: sourceCommit,
    expectedSourceSha: sourceCommit,
  });
  assert.equal(result.packageSignature, "absent");
  assert.equal(result.distributionTrust, "unsigned-candidate");
  assert.equal(result.zipFormat, "zip64-makeappx");
  assert.equal(result.desktopArtifactId, application.manifest.desktopArtifactId);
  assert.equal(result.verifiedFileCount, result.sourceFileCount);
  assert.ok(result.blockMapBlockCount > 0);
});

test("full verifier rejects bad hashes and wrong compressed/stored Block Size semantics", async () => {
  for (const mutation of [
    "bad-hash",
    "stored-size",
    "compressed-size-missing",
    "compressed-size-with-wrapper",
    "compressed-boundary-redistributed",
  ] as const) {
    const root = temporaryDirectory();
    const application = createSyntheticFinalizedApplication(root);
    const msixPath = writeSyntheticMsix({ root, appRoot: application.appRoot, mutation });
    await assert.rejects(verifyUnsignedMsix({
      msixPath,
      applicationRoot: application.appRoot,
      manifestPath: join(msixRoot, "AppxManifest.xml"),
      assetsRoot: join(msixRoot, "assets"),
      checkedOutCommit: sourceCommit,
      expectedSourceSha: sourceCommit,
    }), /reconcile|Block Size/u, mutation);
  }
});
