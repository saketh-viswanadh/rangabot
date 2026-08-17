import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import { inspectUnsignedMsixZipEnvelope } from "../lib/windows-msix-verifier.ts";

const crcTable = Object.freeze(Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
}));

function crc32(source: Buffer) {
  let crc = 0xffffffff;
  for (const byte of source) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function createStoredZip(entries: readonly Readonly<{ name: string; content: Buffer }>[]) {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.content.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.content.length, 20);
    central.writeUInt32LE(entry.content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    localParts.push(local, name, entry.content);
    centralParts.push(central, name);
    localOffset += local.length + name.length + entry.content.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, central, end]);
}

function createMakeAppxZip64(entriesInput: readonly Readonly<{
  name: string;
  content: Buffer;
  compressed?: boolean;
  encodedName?: string;
  trailingCompressedBytes?: Buffer;
}>[]) {
  const entries = entriesInput.map((entry) => Object.freeze({
    ...entry,
    body: entry.compressed
      ? Buffer.concat([deflateRawSync(entry.content), entry.trailingCompressedBytes ?? Buffer.alloc(0)])
      : entry.content,
    method: entry.compressed ? 8 : 0,
    crc: crc32(entry.content),
  }));
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const encodedName = entry.encodedName ?? (entry.name === "[Content_Types].xml"
      ? entry.name
      : [...Buffer.from(entry.name, "utf8")].map((byte) => {
        if ((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)
          || (byte >= 0x30 && byte <= 0x39) || byte === 0x2d || byte === 0x2e
          || byte === 0x5f || byte === 0x7e || byte === 0x2f) return String.fromCharCode(byte);
        return `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      }).join(""));
    const name = Buffer.from(encodedName, "ascii");
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

function writeFixture(entries: readonly Readonly<{ name: string; content: Buffer }>[]) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "rangabot-msix-zip-test-"));
  test.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "fixture.msix");
  writeFileSync(path, createStoredZip(entries));
  return path;
}

function writeZipFixture(source: Buffer) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "rangabot-msix-zip64-test-"));
  test.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "fixture.msix");
  writeFileSync(path, source);
  return path;
}

const manifest = Buffer.from("<Package><Identity Name=\"Synthetic\" /></Package>\n", "utf8");

test("MSIX envelope extracts exact manifest and proves package signature absence", async () => {
  const path = writeFixture([
    { name: "AppxManifest.xml", content: manifest },
    { name: "AppxBlockMap.xml", content: Buffer.from("block map fixture") },
    { name: "[Content_Types].xml", content: Buffer.from("content types fixture") },
  ]);
  const envelope = await inspectUnsignedMsixZipEnvelope(path);
  assert.equal(envelope.packageSignature, "absent");
  assert.deepEqual(envelope.manifest.content, manifest);
  assert.equal(envelope.entries.length, 3);
});

test("MSIX envelope rejects a signature entry case-insensitively", async () => {
  const path = writeFixture([
    { name: "AppxManifest.xml", content: manifest },
    { name: "appxsignature.p7x", content: Buffer.from("not a real signature") },
  ]);
  await assert.rejects(inspectUnsignedMsixZipEnvelope(path), /AppxSignature/u);
});

test("MSIX envelope rejects unsafe entry names and casefold collisions", async () => {
  const unsafe = writeFixture([
    { name: "AppxManifest.xml", content: manifest },
    { name: "CON.txt", content: Buffer.from("unsafe") },
  ]);
  await assert.rejects(inspectUnsignedMsixZipEnvelope(unsafe), /Windows-unsafe/u);
  const collision = writeFixture([
    { name: "AppxManifest.xml", content: manifest },
    { name: "Foo.txt", content: Buffer.from("one") },
    { name: "foo.txt", content: Buffer.from("two") },
  ]);
  await assert.rejects(inspectUnsignedMsixZipEnvelope(collision), /path collision/u);
});

function makeAppxZip64Fixture() {
  return createMakeAppxZip64([
    { name: "AppxManifest.xml", content: manifest, compressed: true },
    { name: "AppxBlockMap.xml", content: Buffer.from("block map fixture") },
    { name: "resources/chunk[1]%5B.js", content: Buffer.from("encoded name fixture") },
    { name: "[Content_Types].xml", content: Buffer.from("content types fixture") },
  ]);
}

function zip64FixtureOffsets(source: Buffer) {
  const classicOffset = source.length - 22;
  const locatorOffset = classicOffset - 20;
  const zip64Offset = Number(source.readBigUInt64LE(locatorOffset + 8));
  const centralOffset = Number(source.readBigUInt64LE(zip64Offset + 48));
  const firstNameBytes = source.readUInt16LE(centralOffset + 28);
  const firstExtraOffset = centralOffset + 46 + firstNameBytes;
  const firstCompressedBytes = Number(source.readBigUInt64LE(firstExtraOffset + 12));
  const firstLocalNameBytes = source.readUInt16LE(26);
  const firstDescriptorOffset = 30 + firstLocalNameBytes + firstCompressedBytes;
  return { classicOffset, locatorOffset, zip64Offset, centralOffset, firstExtraOffset, firstDescriptorOffset };
}

test("MSIX envelope accepts the strict Microsoft MakeAppx ZIP64 profile", async () => {
  const envelope = await inspectUnsignedMsixZipEnvelope(writeZipFixture(makeAppxZip64Fixture()));
  assert.equal(envelope.zipFormat, "zip64-makeappx");
  assert.equal(envelope.packageSignature, "absent");
  assert.deepEqual(envelope.manifest.content, manifest);
  assert.equal(envelope.entries.length, 4);
  assert.ok(envelope.entries.some((entry) => entry.name === "resources/chunk[1]%5B.js"));
});

test("MakeAppx ZIP64 requires one canonical path-encoding layer", async () => {
  const encodedSeparator = createMakeAppxZip64([
    { name: "AppxManifest.xml", encodedName: "AppxManifest%2Exml", content: manifest },
  ]);
  const lowercaseEscape = createMakeAppxZip64([
    { name: "AppxManifest.xml", encodedName: "AppxManifest%2exml", content: manifest },
  ]);
  const traversal = createMakeAppxZip64([
    { name: "folder/../AppxManifest.xml", encodedName: "folder/%2E%2E/AppxManifest.xml", content: manifest },
  ]);
  await assert.rejects(inspectUnsignedMsixZipEnvelope(writeZipFixture(encodedSeparator)), /over-encoded/u);
  await assert.rejects(inspectUnsignedMsixZipEnvelope(writeZipFixture(lowercaseEscape)), /canonical/u);
  await assert.rejects(inspectUnsignedMsixZipEnvelope(writeZipFixture(traversal)), /over-encoded|traversal/u);
});

test("MSIX envelope rejects bytes hidden after a valid DEFLATE end marker", async () => {
  const hidden = createMakeAppxZip64([
    {
      name: "AppxManifest.xml",
      content: manifest,
      compressed: true,
      trailingCompressedBytes: Buffer.from("PRIVATE"),
    },
  ]);
  await assert.rejects(inspectUnsignedMsixZipEnvelope(writeZipFixture(hidden)), /trailing or unconsumed DEFLATE/u);
});

test("MakeAppx ZIP64 rejects malformed locator, EOCD, sentinels, and counts", async () => {
  const mutations = [
    (source: Buffer, offsets: ReturnType<typeof zip64FixtureOffsets>) => source.writeUInt32LE(0, offsets.locatorOffset),
    (source: Buffer, offsets: ReturnType<typeof zip64FixtureOffsets>) => source.writeBigUInt64LE(BigInt(offsets.zip64Offset + 1), offsets.locatorOffset + 8),
    (source: Buffer, offsets: ReturnType<typeof zip64FixtureOffsets>) => source.writeUInt32LE(2, offsets.locatorOffset + 16),
    (source: Buffer, offsets: ReturnType<typeof zip64FixtureOffsets>) => source.writeBigUInt64LE(BigInt(45), offsets.zip64Offset + 4),
    (source: Buffer, offsets: ReturnType<typeof zip64FixtureOffsets>) => source.writeUInt16LE(46, offsets.zip64Offset + 14),
    (source: Buffer, offsets: ReturnType<typeof zip64FixtureOffsets>) => source.writeUInt16LE(0, offsets.classicOffset + 4),
    (source: Buffer, offsets: ReturnType<typeof zip64FixtureOffsets>) => source.writeBigUInt64LE(BigInt(5), offsets.zip64Offset + 32),
  ];
  for (const mutate of mutations) {
    const source = makeAppxZip64Fixture();
    mutate(source, zip64FixtureOffsets(source));
    await assert.rejects(inspectUnsignedMsixZipEnvelope(writeZipFixture(source)), /ZIP64|central directory/u);
  }
});

test("MakeAppx ZIP64 rejects malformed extras, offsets, local fields, and descriptors", async () => {
  const mutations = [
    (source: Buffer, offsets: ReturnType<typeof zip64FixtureOffsets>) => source.writeUInt16LE(0x0002, offsets.firstExtraOffset),
    (source: Buffer, offsets: ReturnType<typeof zip64FixtureOffsets>) => source.writeUInt16LE(23, offsets.firstExtraOffset + 2),
    (source: Buffer, offsets: ReturnType<typeof zip64FixtureOffsets>) => source.writeBigUInt64LE(BigInt(1), offsets.firstExtraOffset + 20),
    (source: Buffer, offsets: ReturnType<typeof zip64FixtureOffsets>) => source.writeBigUInt64LE(BigInt(offsets.centralOffset + 1), offsets.zip64Offset + 48),
    (source: Buffer, offsets: ReturnType<typeof zip64FixtureOffsets>) => source.writeUInt16LE(1, offsets.centralOffset + 36),
    (source: Buffer) => source.writeUInt16LE(1, 28),
    (source: Buffer) => source.writeUInt32LE(1, 14),
    (source: Buffer) => source.writeUInt16LE(1, 10),
    (source: Buffer) => source.writeUInt8(0x42, 30),
    (source: Buffer, offsets: ReturnType<typeof zip64FixtureOffsets>) => source.writeUInt32LE(0, offsets.firstDescriptorOffset),
    (source: Buffer, offsets: ReturnType<typeof zip64FixtureOffsets>) => source.writeBigUInt64LE(BigInt(1), offsets.firstDescriptorOffset + 8),
  ];
  for (const mutate of mutations) {
    const source = makeAppxZip64Fixture();
    mutate(source, zip64FixtureOffsets(source));
    await assert.rejects(inspectUnsignedMsixZipEnvelope(writeZipFixture(source)), /ZIP64|central directory|local|descriptor|entry names/u);
  }
});
