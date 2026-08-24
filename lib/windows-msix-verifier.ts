import { createHash } from "node:crypto";
import { createReadStream, closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { crc32, createInflateRaw } from "node:zlib";
import { resolve } from "node:path";
import { inspectDesktopArtifact, parseDesktopArtifactManifest } from "./desktop-artifact-identity.ts";
import {
  APPROVED_MSIX_MANIFEST_SHA256,
  assertMsixSourceInventoryUnchanged,
  collectMsixSourceInventory,
  MAXIMUM_MSIX_BYTES_EXCLUSIVE,
  MAXIMUM_MSIX_SOURCE_BYTES_EXCLUSIVE,
  MSIX_DESKTOP_MANIFEST_PACKAGE_PATH,
  msixIdentityVersionForProductVersion,
  readExpectedMsixManifestIdentity,
  type MsixSourceEntry,
} from "./windows-msix.ts";
import {
  assertStableFileUnchanged,
  assertOpenDescriptorMatchesStableFile,
  assertUniqueWindowsPackagePaths,
  inspectStableFile,
  validateWindowsPackagePath,
  windowsPackagePathKey,
} from "./windows-msix-path-policy.ts";

const maximumCentralDirectoryBytes = 64 * 1024 * 1024;
const maximumZipEntries = 100_000;
const maximumMetadataBytes = 4 * 1024 * 1024;
const maximumBlockMapAbsoluteBytes = 128 * 1024 * 1024;
const appxBlockBytes = 64 * 1024;
const blockMapHashMethod = "http://www.w3.org/2001/04/xmlenc#sha256";
const blockMapNamespace = "http://schemas.microsoft.com/appx/2010/blockmap";
const blockMapFileHashNamespace = "http://schemas.microsoft.com/appx/2021/blockmap";
const contentTypesNamespace = "http://schemas.openxmlformats.org/package/2006/content-types";
const manifestContentType = "application/vnd.ms-appx.manifest+xml";
const blockMapContentType = "application/vnd.ms-appx.blockmap+xml";
const makeAppxBlockBoundary = Buffer.from([0x00, 0x00, 0xff, 0xff]);
const makeAppxDeflateTrailer = Buffer.from([0x03, 0x00]);
const generatedPackageEntries = new Set(["AppxBlockMap.xml", "[Content_Types].xml"]);

type RandomReader = Readonly<{
  size: number;
  read(offset: number, bytes: number): Buffer;
}>;

export type MsixZipEntry = Readonly<{
  name: string;
  flags: number;
  compressionMethod: 0 | 8;
  crc32: number;
  dosTime: number;
  dosDate: number;
  compressedBytes: number;
  uncompressedBytes: number;
  localHeaderOffset: number;
  localHeaderBytes: number;
  dataOffset: number;
}>;

type ZipFormat = "zip32" | "zip64-makeappx";

export type AppxBlockMapFile = Readonly<{
  name: string;
  size: number;
  localHeaderBytes: number;
  blocks: readonly Readonly<{ hash: string; compressedBytes: number | null }>[];
  fileHash: string | null;
}>;

export type MsixContentTypes = Readonly<{
  namespace: typeof contentTypesNamespace;
  defaults: readonly Readonly<{ extension: string; contentType: string }>[];
  overrides: readonly Readonly<{ partName: string; packagePath: string; contentType: string }>[];
}>;

function descriptorReader(descriptor: number, size: number, label: string): RandomReader {
  return Object.freeze({
    size,
    read(offset, bytes) {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(bytes) || offset < 0 || bytes < 0
        || offset > size - bytes) throw new Error(`${label} has an out-of-bounds ZIP structure.`);
      const output = Buffer.allocUnsafe(bytes);
      let position = 0;
      while (position < bytes) {
        const count = readSync(descriptor, output, position, bytes - position, offset + position);
        if (count === 0) throw new Error(`${label} ended while its ZIP structure was read.`);
        position += count;
      }
      return output;
    },
  });
}

function encodeMakeAppxZipName(packagePath: string) {
  if (packagePath === "[Content_Types].xml") return packagePath;
  let encoded = "";
  for (const byte of Buffer.from(packagePath, "utf8")) {
    if ((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)
      || (byte >= 0x30 && byte <= 0x39) || byte === 0x2d || byte === 0x2e
      || byte === 0x5f || byte === 0x7e || byte === 0x2f) {
      encoded += String.fromCharCode(byte);
    } else {
      encoded += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return encoded;
}

function decodeMakeAppxZipName(source: Buffer, label: string) {
  if (source.length === 0 || source.some((value) => value > 0x7f)) {
    throw new Error(`${label} has a non-ASCII MakeAppx ZIP entry name.`);
  }
  const encoded = source.toString("ascii");
  if (encoded === "[Content_Types].xml") return encoded;
  const decodedBytes: number[] = [];
  for (let offset = 0; offset < encoded.length;) {
    const value = encoded.charCodeAt(offset);
    if ((value >= 0x41 && value <= 0x5a) || (value >= 0x61 && value <= 0x7a)
      || (value >= 0x30 && value <= 0x39) || value === 0x2d || value === 0x2e
      || value === 0x5f || value === 0x7e || value === 0x2f) {
      decodedBytes.push(value);
      offset += 1;
      continue;
    }
    if (value !== 0x25 || offset > encoded.length - 3
      || !/^[0-9A-F]{2}$/u.test(encoded.slice(offset + 1, offset + 3))) {
      throw new Error(`${label} has a non-canonical MakeAppx ZIP entry name.`);
    }
    const decoded = Number.parseInt(encoded.slice(offset + 1, offset + 3), 16);
    if (decoded === 0 || decoded === 0x2f || decoded === 0x5c
      || (decoded >= 0x41 && decoded <= 0x5a) || (decoded >= 0x61 && decoded <= 0x7a)
      || (decoded >= 0x30 && decoded <= 0x39) || decoded === 0x2d || decoded === 0x2e
      || decoded === 0x5f || decoded === 0x7e) {
      throw new Error(`${label} has an unsafe or over-encoded MakeAppx ZIP entry name.`);
    }
    decodedBytes.push(decoded);
    offset += 3;
  }
  let name: string;
  try {
    name = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(decodedBytes));
  } catch {
    throw new Error(`${label} has an invalid percent-encoded UTF-8 ZIP entry name.`);
  }
  if (encodeMakeAppxZipName(name) !== encoded) {
    throw new Error(`${label} has a non-canonical MakeAppx ZIP entry name.`);
  }
  return name;
}

function decodeZipName(source: Buffer, flags: number, label: string, format: ZipFormat) {
  if (source.length === 0 || source.includes(0) || source.includes(13) || source.includes(10)) {
    throw new Error(`${label} has an invalid ZIP entry name.`);
  }
  if (format === "zip64-makeappx") {
    return validateWindowsPackagePath(decodeMakeAppxZipName(source, label), `${label} ZIP entry name`);
  }
  if ((flags & 0x0800) === 0 && source.some((value) => value > 0x7f)) {
    throw new Error(`${label} has an ambiguous non-UTF-8 ZIP entry name.`);
  }
  let name: string;
  try {
    name = (flags & 0x0800) !== 0
      ? new TextDecoder("utf-8", { fatal: true }).decode(source)
      : source.toString("ascii");
  } catch {
    throw new Error(`${label} has an invalid UTF-8 ZIP entry name.`);
  }
  return validateWindowsPackagePath(name, `${label} ZIP entry name`);
}

function assertSafeZip32Extra(source: Buffer, label: string) {
  const seen = new Set<number>();
  let offset = 0;
  while (offset < source.length) {
    if (offset > source.length - 4) throw new Error(`${label} has a truncated ZIP extra field.`);
    const id = source.readUInt16LE(offset);
    const bytes = source.readUInt16LE(offset + 2);
    offset += 4;
    if (offset > source.length - bytes) throw new Error(`${label} has an invalid ZIP extra field.`);
    if (id === 0x0001) throw new Error(`${label} unexpectedly requires ZIP64.`);
    if (seen.has(id)) throw new Error(`${label} repeats a ZIP extra field.`);
    seen.add(id);
    offset += bytes;
  }
}

function safeZip64Integer(source: Buffer, offset: number, label: string) {
  const value = source.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds the safe integer range.`);
  return Number(value);
}

function parseMakeAppxZip64Extra(source: Buffer, label: string) {
  if (source.length !== 28 || source.readUInt16LE(0) !== 0x0001 || source.readUInt16LE(2) !== 24) {
    throw new Error(`${label} must contain only the exact MakeAppx ZIP64 extra field.`);
  }
  return Object.freeze({
    uncompressedBytes: safeZip64Integer(source, 4, `${label} uncompressed size`),
    compressedBytes: safeZip64Integer(source, 12, `${label} compressed size`),
    localHeaderOffset: safeZip64Integer(source, 20, `${label} local-header offset`),
  });
}

function validateCentralDirectoryBounds(input: Readonly<{
  entries: number;
  centralBytes: number;
  centralOffset: number;
  centralEndOffset: number;
}>, label: string) {
  if (!Number.isSafeInteger(input.entries) || input.entries <= 0 || input.entries > maximumZipEntries
    || !Number.isSafeInteger(input.centralBytes) || input.centralBytes <= 0
    || input.centralBytes > maximumCentralDirectoryBytes
    || !Number.isSafeInteger(input.centralOffset) || input.centralOffset < 0
    || input.centralOffset > input.centralEndOffset - input.centralBytes
    || input.centralOffset + input.centralBytes !== input.centralEndOffset) {
    throw new Error(`${label} has an invalid ZIP central directory.`);
  }
}

function findEndOfCentralDirectory(reader: RandomReader, label: string) {
  if (reader.size < 22) throw new Error(`${label} has no exact ZIP end-of-central-directory record.`);
  const classicOffset = reader.size - 22;
  const classic = reader.read(classicOffset, 22);
  if (classic.readUInt32LE(0) !== 0x06054b50 || classic.readUInt16LE(20) !== 0) {
    throw new Error(`${label} must end with one comment-free ZIP end-of-central-directory record.`);
  }
  const classicValues = Object.freeze({
    disk: classic.readUInt16LE(4),
    centralDisk: classic.readUInt16LE(6),
    diskEntries: classic.readUInt16LE(8),
    entries: classic.readUInt16LE(10),
    centralBytes: classic.readUInt32LE(12),
    centralOffset: classic.readUInt32LE(16),
  });
  const sentinels = [
    classicValues.disk === 0xffff,
    classicValues.centralDisk === 0xffff,
    classicValues.diskEntries === 0xffff,
    classicValues.entries === 0xffff,
    classicValues.centralBytes === 0xffffffff,
    classicValues.centralOffset === 0xffffffff,
  ];
  if (sentinels.some(Boolean)) {
    if (!sentinels.every(Boolean) || classicOffset < 76) {
      throw new Error(`${label} has a hybrid or truncated ZIP64 end structure.`);
    }
    const locatorOffset = classicOffset - 20;
    const locator = reader.read(locatorOffset, 20);
    if (locator.readUInt32LE(0) !== 0x07064b50 || locator.readUInt32LE(4) !== 0
      || locator.readUInt32LE(16) !== 1) {
      throw new Error(`${label} has an invalid single-disk ZIP64 locator.`);
    }
    const zip64Offset = safeZip64Integer(locator, 8, `${label} ZIP64 EOCD offset`);
    if (zip64Offset !== locatorOffset - 56) {
      throw new Error(`${label} ZIP64 locator does not point to one adjacent exact EOCD record.`);
    }
    const zip64 = reader.read(zip64Offset, 56);
    if (zip64.readUInt32LE(0) !== 0x06064b50
      || safeZip64Integer(zip64, 4, `${label} ZIP64 EOCD size`) !== 44
      || zip64.readUInt16LE(12) !== 45 || zip64.readUInt16LE(14) !== 45
      || zip64.readUInt32LE(16) !== 0 || zip64.readUInt32LE(20) !== 0) {
      throw new Error(`${label} does not have the exact MakeAppx ZIP64 EOCD profile.`);
    }
    const diskEntries = safeZip64Integer(zip64, 24, `${label} ZIP64 disk entry count`);
    const entries = safeZip64Integer(zip64, 32, `${label} ZIP64 total entry count`);
    const centralBytes = safeZip64Integer(zip64, 40, `${label} ZIP64 central-directory size`);
    const centralOffset = safeZip64Integer(zip64, 48, `${label} ZIP64 central-directory offset`);
    if (diskEntries !== entries) {
      throw new Error(`${label} ZIP64 entry counts do not describe one disk.`);
    }
    validateCentralDirectoryBounds({
      entries,
      centralBytes,
      centralOffset,
      centralEndOffset: zip64Offset,
    }, label);
    return Object.freeze({
      format: "zip64-makeappx" as const,
      entries,
      centralBytes,
      centralOffset,
      centralEndOffset: zip64Offset,
    });
  }
  if (classicValues.disk !== 0 || classicValues.centralDisk !== 0
    || classicValues.diskEntries !== classicValues.entries) {
    throw new Error(`${label} must be one comment-free, single-disk MSIX ZIP.`);
  }
  validateCentralDirectoryBounds({
    entries: classicValues.entries,
    centralBytes: classicValues.centralBytes,
    centralOffset: classicValues.centralOffset,
    centralEndOffset: classicOffset,
  }, label);
  return Object.freeze({
    format: "zip32" as const,
    entries: classicValues.entries,
    centralBytes: classicValues.centralBytes,
    centralOffset: classicValues.centralOffset,
    centralEndOffset: classicOffset,
  });
}

function parseCentralDirectory(reader: RandomReader, label: string) {
  const end = findEndOfCentralDirectory(reader, label);
  const source = reader.read(end.centralOffset, end.centralBytes);
  const entries: (Omit<MsixZipEntry, "localHeaderBytes" | "dataOffset"> & Readonly<{ encodedName: Buffer }>)[] = [];
  let offset = 0;
  for (let index = 0; index < end.entries; index += 1) {
    if (offset > source.length - 46 || source.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`${label} has a truncated ZIP central entry.`);
    }
    const versionMadeBy = source.readUInt16LE(offset + 4);
    const versionNeeded = source.readUInt16LE(offset + 6);
    const flags = source.readUInt16LE(offset + 8);
    const compressionMethod = source.readUInt16LE(offset + 10);
    const dosTime = source.readUInt16LE(offset + 12);
    const dosDate = source.readUInt16LE(offset + 14);
    const crc32 = source.readUInt32LE(offset + 16);
    const compressedBytes32 = source.readUInt32LE(offset + 20);
    const uncompressedBytes32 = source.readUInt32LE(offset + 24);
    const nameBytes = source.readUInt16LE(offset + 28);
    const extraBytes = source.readUInt16LE(offset + 30);
    const commentBytes = source.readUInt16LE(offset + 32);
    const disk = source.readUInt16LE(offset + 34);
    const internalAttributes = source.readUInt16LE(offset + 36);
    const externalAttributes = source.readUInt32LE(offset + 38);
    const localHeaderOffset32 = source.readUInt32LE(offset + 42);
    const totalBytes = 46 + nameBytes + extraBytes + commentBytes;
    if (offset > source.length - totalBytes || disk !== 0 || commentBytes !== 0
      || (flags & 0x0001) !== 0 || (compressionMethod !== 0 && compressionMethod !== 8)) {
      throw new Error(`${label} has an unsupported or unsafe ZIP central entry.`);
    }
    let compressedBytes: number;
    let uncompressedBytes: number;
    let localHeaderOffset: number;
    const extra = source.subarray(offset + 46 + nameBytes, offset + 46 + nameBytes + extraBytes);
    if (end.format === "zip64-makeappx") {
      if (versionMadeBy !== 45 || versionNeeded !== 45 || (flags & 0x0008) === 0
        || flags !== 0x0008 || compressedBytes32 !== 0xffffffff
        || uncompressedBytes32 !== 0xffffffff || localHeaderOffset32 !== 0xffffffff
        || internalAttributes !== 0 || externalAttributes !== 0) {
        throw new Error(`${label} has a non-MakeAppx ZIP64 central entry.`);
      }
      ({ compressedBytes, uncompressedBytes, localHeaderOffset } = parseMakeAppxZip64Extra(extra, label));
      if (compressedBytes >= MAXIMUM_MSIX_BYTES_EXCLUSIVE
        || uncompressedBytes >= MAXIMUM_MSIX_SOURCE_BYTES_EXCLUSIVE
        || localHeaderOffset >= end.centralOffset) {
        throw new Error(`${label} has an out-of-bounds ZIP64 central entry.`);
      }
    } else {
      if (versionNeeded > 20 || compressedBytes32 === 0xffffffff
        || uncompressedBytes32 === 0xffffffff || localHeaderOffset32 === 0xffffffff
        || (flags & ~0x080e) !== 0 || (compressionMethod === 0 && (flags & 0x0006) !== 0)) {
        throw new Error(`${label} has an unsupported or unsafe ZIP central entry.`);
      }
      assertSafeZip32Extra(extra, label);
      compressedBytes = compressedBytes32;
      uncompressedBytes = uncompressedBytes32;
      localHeaderOffset = localHeaderOffset32;
    }
    if ((compressionMethod === 0 && compressedBytes !== uncompressedBytes)
      || compressedBytes > reader.size || uncompressedBytes >= MAXIMUM_MSIX_SOURCE_BYTES_EXCLUSIVE) {
      throw new Error(`${label} has impossible ZIP entry sizes.`);
    }
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0o170000) === 0o120000 || (externalAttributes & 0x10) !== 0) {
      throw new Error(`${label} contains a linked or directory ZIP entry.`);
    }
    const encodedName = Buffer.from(source.subarray(offset + 46, offset + 46 + nameBytes));
    const name = decodeZipName(encodedName, flags, label, end.format);
    entries.push(Object.freeze({
      name,
      encodedName,
      flags,
      compressionMethod: compressionMethod as 0 | 8,
      crc32,
      dosTime,
      dosDate,
      compressedBytes,
      uncompressedBytes,
      localHeaderOffset,
    }));
    offset += totalBytes;
  }
  if (offset !== source.length) throw new Error(`${label} has trailing ZIP central-directory bytes.`);
  assertUniqueWindowsPackagePaths(entries.map((entry) => entry.name), `${label} ZIP`);
  const layout = [...entries].sort((left, right) => left.localHeaderOffset - right.localHeaderOffset);
  if (layout[0]?.localHeaderOffset !== 0
    || new Set(layout.map((entry) => entry.localHeaderOffset)).size !== layout.length) {
    throw new Error(`${label} has an invalid ZIP local-entry layout.`);
  }
  const completed: MsixZipEntry[] = [];
  for (let index = 0; index < layout.length; index += 1) {
    const entry = layout[index];
    const expectedEnd = layout[index + 1]?.localHeaderOffset ?? end.centralOffset;
    if (entry.localHeaderOffset > expectedEnd - 30) throw new Error(`${label} has overlapping ZIP entries.`);
    const local = reader.read(entry.localHeaderOffset, 30);
    const localVersion = local.readUInt16LE(4);
    if (local.readUInt32LE(0) !== 0x04034b50
      || local.readUInt16LE(6) !== entry.flags || local.readUInt16LE(8) !== entry.compressionMethod
      || local.readUInt16LE(10) !== entry.dosTime || local.readUInt16LE(12) !== entry.dosDate
      || (end.format === "zip64-makeappx" ? localVersion !== 45 : localVersion > 20)) {
      throw new Error(`${label} has an inconsistent ZIP local header.`);
    }
    if (end.format === "zip64-makeappx" && (local.readUInt32LE(14) !== 0
      || local.readUInt32LE(18) !== 0 || local.readUInt32LE(22) !== 0)) {
      throw new Error(`${label} has ambiguous MakeAppx ZIP64 local size or CRC fields.`);
    }
    if (end.format === "zip32" && (entry.flags & 0x0008) === 0
      && (local.readUInt32LE(14) !== entry.crc32
        || local.readUInt32LE(18) !== entry.compressedBytes
        || local.readUInt32LE(22) !== entry.uncompressedBytes)) {
      throw new Error(`${label} has mismatched ZIP local size or CRC evidence.`);
    }
    const nameBytes = local.readUInt16LE(26);
    const extraBytes = local.readUInt16LE(28);
    const localEncodedName = reader.read(entry.localHeaderOffset + 30, nameBytes);
    const localName = decodeZipName(
      localEncodedName,
      entry.flags,
      label,
      end.format,
    );
    if (!localEncodedName.equals(entry.encodedName) || localName !== entry.name) {
      throw new Error(`${label} has mismatched ZIP entry names.`);
    }
    const localExtra = reader.read(entry.localHeaderOffset + 30 + nameBytes, extraBytes);
    if (end.format === "zip64-makeappx") {
      if (extraBytes !== 0) throw new Error(`${label} MakeAppx ZIP64 local entry has optional extra fields.`);
    } else {
      assertSafeZip32Extra(localExtra, label);
    }
    const localHeaderBytes = 30 + nameBytes + extraBytes;
    const dataOffset = entry.localHeaderOffset + localHeaderBytes;
    if (dataOffset > expectedEnd - entry.compressedBytes) throw new Error(`${label} has an out-of-bounds ZIP body.`);
    const bodyEnd = dataOffset + entry.compressedBytes;
    const trailingBytes = expectedEnd - bodyEnd;
    if (end.format === "zip64-makeappx") {
      if (trailingBytes !== 24) throw new Error(`${label} has an invalid MakeAppx ZIP64 data descriptor.`);
      const descriptor = reader.read(bodyEnd, 24);
      if (descriptor.readUInt32LE(0) !== 0x08074b50 || descriptor.readUInt32LE(4) !== entry.crc32
        || safeZip64Integer(descriptor, 8, `${label} ZIP64 descriptor compressed size`) !== entry.compressedBytes
        || safeZip64Integer(descriptor, 16, `${label} ZIP64 descriptor uncompressed size`) !== entry.uncompressedBytes) {
        throw new Error(`${label} has inconsistent MakeAppx ZIP64 data-descriptor evidence.`);
      }
    } else if ((entry.flags & 0x0008) === 0) {
      if (trailingBytes !== 0) throw new Error(`${label} has an unexplained ZIP local-entry gap.`);
    } else {
      if (trailingBytes !== 12 && trailingBytes !== 16) throw new Error(`${label} has an invalid ZIP data descriptor.`);
      const descriptor = reader.read(bodyEnd, trailingBytes);
      const values = trailingBytes === 16 ? 4 : 0;
      if ((trailingBytes === 16 && descriptor.readUInt32LE(0) !== 0x08074b50)
        || descriptor.readUInt32LE(values) !== entry.crc32
        || descriptor.readUInt32LE(values + 4) !== entry.compressedBytes
        || descriptor.readUInt32LE(values + 8) !== entry.uncompressedBytes) {
        throw new Error(`${label} has inconsistent ZIP data-descriptor evidence.`);
      }
    }
    const { encodedName: _encodedName, ...publicEntry } = entry;
    completed.push(Object.freeze({ ...publicEntry, localHeaderBytes, dataOffset }));
  }
  return Object.freeze({
    format: end.format as ZipFormat,
    entries: Object.freeze(completed.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)))),
    centralOffset: end.centralOffset,
  });
}

export async function inspectUnsignedMsixZipEnvelope(msixPath: string) {
  const packageEvidence = inspectStableFile(msixPath, {
    label: "Unsigned MSIX envelope",
    maximumBytes: MAXIMUM_MSIX_BYTES_EXCLUSIVE,
  });
  if (packageEvidence.bytes >= MAXIMUM_MSIX_BYTES_EXCLUSIVE) {
    throw new Error("MSIX envelope reaches the exact 2 GiB distribution limit.");
  }
  const descriptor = openSync(packageEvidence.path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    assertOpenDescriptorMatchesStableFile(descriptor, packageEvidence, "Unsigned MSIX envelope");
    const zip = parseCentralDirectory(
      descriptorReader(descriptor, packageEvidence.bytes, "Unsigned MSIX envelope"),
      "Unsigned MSIX envelope",
    );
    const byPath = mapByPath(zip.entries);
    if (byPath.has(windowsPackagePathKey("AppxSignature.p7x"))) {
      throw new Error("Unsigned MSIX envelope unexpectedly contains AppxSignature.p7x.");
    }
    const manifest = byPath.get(windowsPackagePathKey("AppxManifest.xml"));
    if (!manifest || manifest.name !== "AppxManifest.xml") {
      throw new Error("Unsigned MSIX envelope is missing exact AppxManifest.xml.");
    }
    const inspectedManifest = await inspectEntry({
      descriptor,
      path: packageEvidence.path,
      entry: manifest,
      capture: true,
      maximumCaptureBytes: maximumMetadataBytes,
    });
    assertStableFileUnchanged(packageEvidence, "Unsigned MSIX envelope");
    return Object.freeze({
      bytes: packageEvidence.bytes,
      sha256: packageEvidence.sha256,
      zipFormat: zip.format,
      packageSignature: "absent" as const,
      entries: Object.freeze(zip.entries.map((entry) => Object.freeze({
        name: entry.name,
        compressedBytes: entry.compressedBytes,
        uncompressedBytes: entry.uncompressedBytes,
        compressionMethod: entry.compressionMethod,
        localHeaderBytes: entry.localHeaderBytes,
      }))),
      manifest: Object.freeze({
        bytes: inspectedManifest.bytes,
        sha256: inspectedManifest.sha256,
        content: inspectedManifest.content ?? Buffer.alloc(0),
      }),
    });
  } finally {
    closeSync(descriptor);
  }
}

async function inspectEntry(input: Readonly<{
  descriptor: number;
  path: string;
  entry: MsixZipEntry;
  capture: boolean;
  maximumCaptureBytes: number;
  expectedCompressedBlocks?: AppxBlockMapFile["blocks"];
}>) {
  const sha256 = createHash("sha256");
  const block = Buffer.allocUnsafe(appxBlockBytes);
  const blockHashes: string[] = [];
  const captured: Buffer[] = [];
  let blockOffset = 0;
  let bytes = 0;
  let crc = 0;
  const consume = (value: Buffer | Uint8Array) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    bytes += chunk.length;
    if (bytes > input.entry.uncompressedBytes) throw new Error(`MSIX entry ${input.entry.name} expanded past its declared size.`);
    sha256.update(chunk);
    crc = crc32(chunk, crc);
    if (input.capture) {
      if (bytes > input.maximumCaptureBytes) throw new Error(`MSIX metadata ${input.entry.name} is unexpectedly large.`);
      captured.push(Buffer.from(chunk));
    }
    let chunkOffset = 0;
    while (chunkOffset < chunk.length) {
      const count = Math.min(block.length - blockOffset, chunk.length - chunkOffset);
      chunk.copy(block, blockOffset, chunkOffset, chunkOffset + count);
      blockOffset += count;
      chunkOffset += count;
      if (blockOffset === block.length) {
        blockHashes.push(createHash("sha256").update(block).digest("base64"));
        blockOffset = 0;
      }
    }
  };

  let inflaterBytesWritten: number | null = null;
  if (input.entry.compressionMethod === 8 && input.expectedCompressedBlocks) {
    const compressedSizes = input.expectedCompressedBlocks.map((entry) => entry.compressedBytes);
    if (compressedSizes.some((size) => size === null || size < makeAppxBlockBoundary.length
      || size > appxBlockBytes + 1024)
      || compressedSizes.length !== Math.ceil(input.entry.uncompressedBytes / appxBlockBytes)
      || compressedSizes.reduce<number>((total, size) => total + (size ?? 0), 0) + 2
        !== input.entry.compressedBytes) {
      throw new Error(`MSIX entry ${input.entry.name} has invalid MakeAppx compressed-block boundaries.`);
    }
    const inflater = createInflateRaw();
    let outputError: Error | null = null;
    inflater.on("data", (value: Buffer) => {
      try {
        consume(value);
      } catch (error) {
        outputError = error instanceof Error ? error : new Error(String(error));
        inflater.destroy(outputError);
      }
    });
    const completion = finished(inflater);
    const bodyReader = descriptorReader(
      input.descriptor,
      input.entry.dataOffset + input.entry.compressedBytes,
      `MSIX entry ${input.entry.name}`,
    );
    let compressedOffset = 0;
    try {
      for (let index = 0; index < compressedSizes.length; index += 1) {
        const compressedBytes = compressedSizes[index] ?? 0;
        const beforeBytes = bytes;
        const compressed = bodyReader.read(input.entry.dataOffset + compressedOffset, compressedBytes);
        if (!compressed.subarray(-makeAppxBlockBoundary.length).equals(makeAppxBlockBoundary)) {
          throw new Error(`MSIX entry ${input.entry.name} does not end each compressed Block Size at the exact MakeAppx boundary.`);
        }
        await new Promise<void>((resolveWrite, rejectWrite) => {
          inflater.write(compressed, (error) => error ? rejectWrite(error) : resolveWrite());
        });
        if (outputError) throw outputError;
        compressedOffset += compressedBytes;
        const expectedOutputBytes = Math.min(
          appxBlockBytes,
          input.entry.uncompressedBytes - index * appxBlockBytes,
        );
        if (bytes - beforeBytes !== expectedOutputBytes || inflater.bytesWritten !== compressedOffset) {
          throw new Error(`MSIX entry ${input.entry.name} does not honor its exact compressed Block Size boundary.`);
        }
      }
      const beforeTrailerBytes = bytes;
      const trailer = bodyReader.read(input.entry.dataOffset + compressedOffset, 2);
      if (!trailer.equals(makeAppxDeflateTrailer)) {
        throw new Error(`MSIX entry ${input.entry.name} does not have the exact MakeAppx DEFLATE trailer.`);
      }
      inflater.end(trailer);
      await completion;
      if (outputError) throw outputError;
      if (bytes !== beforeTrailerBytes) {
        throw new Error(`MSIX entry ${input.entry.name} produced content outside its declared Block Size boundaries.`);
      }
      inflaterBytesWritten = inflater.bytesWritten;
    } catch (error) {
      inflater.destroy();
      await completion.catch(() => undefined);
      throw error;
    }
  } else {
    const raw: Readable = input.entry.compressedBytes === 0
      ? Readable.from([])
      : createReadStream(input.path, {
        fd: input.descriptor,
        autoClose: false,
        start: input.entry.dataOffset,
        end: input.entry.dataOffset + input.entry.compressedBytes - 1,
      });
    const inflater = input.entry.compressionMethod === 8 ? createInflateRaw() : null;
    const stream = inflater ? raw.pipe(inflater) : raw;
    if (stream !== raw) raw.on("error", (error) => stream.destroy(error));
    for await (const value of stream) consume(Buffer.isBuffer(value) ? value : Buffer.from(value));
    inflaterBytesWritten = inflater?.bytesWritten ?? null;
  }
  if (inflaterBytesWritten !== null && inflaterBytesWritten !== input.entry.compressedBytes) {
    throw new Error(`MSIX entry ${input.entry.name} has trailing or unconsumed DEFLATE bytes.`);
  }
  if (blockOffset > 0) blockHashes.push(createHash("sha256").update(block.subarray(0, blockOffset)).digest("base64"));
  if (bytes !== input.entry.uncompressedBytes || crc !== input.entry.crc32) {
    throw new Error(`MSIX entry ${input.entry.name} failed ZIP size or CRC verification.`);
  }
  return Object.freeze({
    name: input.entry.name,
    bytes,
    sha256: sha256.digest("hex"),
    blockHashes: Object.freeze(blockHashes),
    ...(input.capture ? { content: Buffer.concat(captured) } : {}),
  });
}

function decodeXmlValue(source: string, label: string) {
  if (/[<>]/u.test(source)) throw new Error(`${label} contains unsafe XML markup.`);
  const entityPattern = /&(?:amp|quot|apos|lt|gt|#(?:x[0-9a-fA-F]+|[0-9]+));/gu;
  let output = "";
  let offset = 0;
  for (const match of source.matchAll(entityPattern)) {
    const index = match.index;
    if (source.slice(offset, index).includes("&")) throw new Error(`${label} contains an unknown XML entity.`);
    output += source.slice(offset, index);
    const entity = match[0];
    let decoded: string;
    if (entity === "&quot;") decoded = "\"";
    else if (entity === "&apos;") decoded = "'";
    else if (entity === "&lt;") decoded = "<";
    else if (entity === "&gt;") decoded = ">";
    else if (entity === "&amp;") decoded = "&";
    else {
      const hexadecimal = entity.startsWith("&#x");
      const value = Number.parseInt(entity.slice(hexadecimal ? 3 : 2, -1), hexadecimal ? 16 : 10);
      if (!Number.isSafeInteger(value) || value <= 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
        throw new Error(`${label} contains an invalid XML character reference.`);
      }
      decoded = String.fromCodePoint(value);
    }
    output += decoded;
    offset = index + entity.length;
  }
  if (source.slice(offset).includes("&")) throw new Error(`${label} contains an unknown XML entity.`);
  return output + source.slice(offset);
}

function parseXmlAttributes(source: string, label: string) {
  const attributes = new Map<string, string>();
  let offset = 0;
  while (offset < source.length) {
    if (!source.slice(offset).trim()) break;
    const match = /^\s+([A-Za-z_][A-Za-z0-9_.:-]*)="([^"]*)"/u.exec(source.slice(offset));
    if (!match) throw new Error(`${label} has invalid XML attributes.`);
    if (attributes.has(match[1])) throw new Error(`${label} repeats an XML attribute.`);
    attributes.set(match[1], decodeXmlValue(match[2], label));
    offset += match[0].length;
  }
  return attributes;
}

function exactAttributeKeys(attributes: ReadonlyMap<string, string>, expected: readonly string[]) {
  const actual = [...attributes.keys()].sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((value, index) => value === wanted[index]);
}

function safeIntegerAttribute(value: string | undefined, label: string) {
  if (!value || !/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error(`${label} is not a canonical integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} exceeds the safe integer range.`);
  return parsed;
}

function decodeFatalUtf8Xml(content: Buffer, label: string, maximumBytes: number) {
  if (content.length <= 0 || content.length > maximumBytes) throw new Error(`${label} has an invalid size.`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content).replace(/^\uFEFF/u, "");
  } catch {
    throw new Error(`${label} is not valid UTF-8 XML.`);
  }
}

function validateContentType(value: string, label: string) {
  if (value.length > 255
    || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(value)) {
    throw new Error(`${label} is not one safe media type.`);
  }
  return value;
}

function decodeOpcPartName(value: string, label: string) {
  if (!value.startsWith("/") || value.length <= 1 || value.startsWith("//")
    || /[\\?#\u0000-\u001f]/u.test(value) || /%(?:2f|5c)/iu.test(value)
    || /%(?![0-9a-fA-F]{2})/u.test(value)) {
    throw new Error(`${label} is not one safe OPC part name.`);
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(value.slice(1));
  } catch {
    throw new Error(`${label} is not one valid UTF-8 OPC part name.`);
  }
  return validateWindowsPackagePath(decoded, label);
}

function assertNoUnsignedTrustDeclaration(input: Readonly<{
  extension?: string;
  packagePath?: string;
  contentType: string;
}>) {
  const extension = input.extension?.toLocaleLowerCase("en-US");
  const packagePath = input.packagePath?.toLocaleLowerCase("en-US") ?? "";
  const contentType = input.contentType.toLocaleLowerCase("en-US");
  if (extension === "p7x" || extension === "cat"
    || /(?:^|\/)(?:appxsignature\.p7x|codeintegrity\.cat)$/u.test(packagePath)
    || /signature|digital-signature|pkiseccat|catalog|codeintegrity/u.test(contentType)) {
    throw new Error("Unsigned MSIX content types unexpectedly declare a signature or catalog.");
  }
}

function packageExtension(packagePath: string) {
  const name = packagePath.slice(packagePath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLocaleLowerCase("en-US") : null;
}

/**
 * Parse the OPC content-type index without a general-purpose XML parser. The
 * accepted grammar is intentionally limited to one Types root containing only
 * empty Default and Override declarations, which is the complete grammar an
 * unsigned MakeAppx package needs here.
 */
export function parseMsixContentTypes(
  content: Buffer,
  packageEntries: readonly (string | Readonly<{ name: string }>)[],
): MsixContentTypes {
  const text = decodeFatalUtf8Xml(content, "[Content_Types].xml", maximumMetadataBytes);
  if (/<!DOCTYPE|<!ENTITY|<!--|<!\[CDATA\[|<\?(?!xml\s)/iu.test(text)) {
    throw new Error("[Content_Types].xml is not canonical safe UTF-8 XML.");
  }
  const root = /^(?:<\?xml\s+version="1\.0"(?:\s+encoding="(?:UTF-8|utf-8)")?(?:\s+standalone="(?:yes|no)")?\s*\?>\s*)?<Types([^>]*)>([\s\S]*)<\/Types>\s*$/u.exec(text);
  if (!root) throw new Error("[Content_Types].xml does not have exactly one Types root.");
  const rootAttributes = parseXmlAttributes(root[1], "[Content_Types].xml root");
  if (!exactAttributeKeys(rootAttributes, ["xmlns"])
    || rootAttributes.get("xmlns") !== contentTypesNamespace) {
    throw new Error("[Content_Types].xml has an unexpected OPC namespace.");
  }

  const packagePaths = packageEntries.map((entry) => typeof entry === "string" ? entry : entry.name);
  assertUniqueWindowsPackagePaths(packagePaths, "[Content_Types].xml package inventory");
  const packageParts = new Map<string, string>();
  for (const packagePath of packagePaths) {
    const canonical = validateWindowsPackagePath(packagePath, "[Content_Types].xml package inventory entry");
    if (canonical === "[Content_Types].xml") continue;
    packageParts.set(windowsPackagePathKey(canonical), canonical);
  }

  const defaults: { extension: string; contentType: string }[] = [];
  const overrides: { partName: string; packagePath: string; contentType: string }[] = [];
  const defaultsByExtension = new Map<string, { extension: string; contentType: string }>();
  const overridesByPath = new Map<string, { partName: string; packagePath: string; contentType: string }>();
  let body = root[2];
  while (body.trim()) {
    body = body.replace(/^\s+/u, "");
    const child = /^<(Default|Override)([^>]*)\/\s*>/u.exec(body);
    if (!child) throw new Error("[Content_Types].xml contains unexpected content.");
    const kind = child[1];
    const attributes = parseXmlAttributes(child[2], `[Content_Types].xml ${kind}`);
    if (kind === "Default") {
      if (!exactAttributeKeys(attributes, ["Extension", "ContentType"])) {
        throw new Error("[Content_Types].xml Default has unexpected attributes.");
      }
      const extension = attributes.get("Extension") ?? "";
      if (extension.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9_+-]*$/u.test(extension)) {
        throw new Error("[Content_Types].xml Default has an unsafe extension.");
      }
      const contentType = validateContentType(
        attributes.get("ContentType") ?? "",
        `[Content_Types].xml Default .${extension}`,
      );
      assertNoUnsignedTrustDeclaration({ extension, contentType });
      const key = extension.toLocaleLowerCase("en-US");
      if (defaultsByExtension.has(key)) {
        throw new Error(`[Content_Types].xml repeats Default extension .${extension}.`);
      }
      const declaration = Object.freeze({ extension, contentType });
      defaults.push(declaration);
      defaultsByExtension.set(key, declaration);
    } else {
      if (!exactAttributeKeys(attributes, ["PartName", "ContentType"])) {
        throw new Error("[Content_Types].xml Override has unexpected attributes.");
      }
      const partName = attributes.get("PartName") ?? "";
      const packagePath = decodeOpcPartName(partName, "[Content_Types].xml Override PartName");
      const contentType = validateContentType(
        attributes.get("ContentType") ?? "",
        `[Content_Types].xml Override ${partName}`,
      );
      assertNoUnsignedTrustDeclaration({ packagePath, contentType });
      const key = windowsPackagePathKey(packagePath);
      if (overridesByPath.has(key)) {
        throw new Error(`[Content_Types].xml repeats Override ${partName}.`);
      }
      const exactPackagePath = packageParts.get(key);
      if (!exactPackagePath || exactPackagePath !== packagePath) {
        throw new Error(`[Content_Types].xml Override ${partName} does not name one exact package part.`);
      }
      const declaration = Object.freeze({ partName, packagePath, contentType });
      overrides.push(declaration);
      overridesByPath.set(key, declaration);
    }
    body = body.slice(child[0].length);
  }

  const blockMapOverride = overridesByPath.get(windowsPackagePathKey("AppxBlockMap.xml"));
  if (!blockMapOverride || blockMapOverride.packagePath !== "AppxBlockMap.xml"
    || blockMapOverride.partName !== "/AppxBlockMap.xml"
    || blockMapOverride.contentType !== blockMapContentType) {
    throw new Error("[Content_Types].xml is missing the exact AppxBlockMap.xml Override.");
  }

  const manifestOverride = overridesByPath.get(windowsPackagePathKey("AppxManifest.xml"));
  const exactManifestOverride = manifestOverride?.packagePath === "AppxManifest.xml"
    && manifestOverride.partName === "/AppxManifest.xml"
    && manifestOverride.contentType === manifestContentType;
  if (manifestOverride && !exactManifestOverride) {
    throw new Error("[Content_Types].xml has an invalid AppxManifest.xml Override.");
  }
  const xmlDefault = defaultsByExtension.get("xml");
  const exactManifestDefault = !manifestOverride
    && xmlDefault?.extension === "xml"
    && xmlDefault.contentType === manifestContentType;
  if (!exactManifestOverride && !exactManifestDefault) {
    throw new Error("[Content_Types].xml does not resolve AppxManifest.xml to the exact manifest content type.");
  }

  const manifestContentTypeDeclarations = [
    ...defaults.filter((declaration) => declaration.contentType.toLocaleLowerCase("en-US") === manifestContentType),
    ...overrides.filter((declaration) => declaration.contentType.toLocaleLowerCase("en-US") === manifestContentType),
  ];
  if (manifestContentTypeDeclarations.length !== 1) {
    throw new Error("[Content_Types].xml has an ambiguous manifest content-type declaration.");
  }
  const blockMapContentTypeDeclarations = [
    ...defaults.filter((declaration) => declaration.contentType.toLocaleLowerCase("en-US") === blockMapContentType),
    ...overrides.filter((declaration) => declaration.contentType.toLocaleLowerCase("en-US") === blockMapContentType),
  ];
  if (blockMapContentTypeDeclarations.length !== 1) {
    throw new Error("[Content_Types].xml has an ambiguous block-map content-type declaration.");
  }

  if (exactManifestDefault) {
    const xmlPackageParts = [...packageParts.values()]
      .filter((packagePath) => packageExtension(packagePath) === "xml")
      .sort();
    if (xmlPackageParts.length !== 2
      || xmlPackageParts[0] !== "AppxBlockMap.xml"
      || xmlPackageParts[1] !== "AppxManifest.xml") {
      throw new Error("[Content_Types].xml may use the manifest XML Default only when no payload XML exists.");
    }
  }

  for (const packagePath of packageParts.values()) {
    const key = windowsPackagePathKey(packagePath);
    if (overridesByPath.has(key)) continue;
    const extension = packageExtension(packagePath);
    if (!extension || !defaultsByExtension.has(extension)) {
      throw new Error(`[Content_Types].xml does not cover package part ${packagePath}.`);
    }
  }

  return Object.freeze({
    namespace: contentTypesNamespace,
    defaults: Object.freeze(defaults),
    overrides: Object.freeze(overrides),
  });
}

export function parseAppxBlockMap(content: Buffer): readonly AppxBlockMapFile[] {
  if (content.length <= 0 || content.length > maximumBlockMapAbsoluteBytes) throw new Error("AppxBlockMap.xml has an invalid size.");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content).replace(/^\uFEFF/u, "");
  } catch {
    throw new Error("AppxBlockMap.xml is not valid UTF-8 XML.");
  }
  if (/<!DOCTYPE|<!ENTITY|<!--|<!\[CDATA\[/iu.test(text)) {
    throw new Error("AppxBlockMap.xml is not canonical safe UTF-8 XML.");
  }
  const root = /^<\?xml\s+version="1\.0"\s+encoding="UTF-8"(?:\s+standalone="no")?\s*\?>\s*<BlockMap([^>]*)>([\s\S]*)<\/BlockMap>\s*$/u.exec(text);
  if (!root) throw new Error("AppxBlockMap.xml does not have one exact BlockMap root.");
  const rootAttributes = parseXmlAttributes(root[1], "AppxBlockMap.xml root");
  const legacyProfile = exactAttributeKeys(rootAttributes, ["HashMethod", "xmlns"]);
  const fileHashProfile = exactAttributeKeys(
    rootAttributes,
    ["HashMethod", "IgnorableNamespaces", "xmlns", "xmlns:b4"],
  )
    && rootAttributes.get("xmlns:b4") === blockMapFileHashNamespace
    && rootAttributes.get("IgnorableNamespaces") === "b4";
  if ((!legacyProfile && !fileHashProfile)
    || rootAttributes.get("HashMethod") !== blockMapHashMethod
    || rootAttributes.get("xmlns") !== blockMapNamespace) {
    const recognizedAttributeNames = new Set(["HashMethod", "IgnorableNamespaces", "xmlns", "xmlns:b4"]);
    const publicRootEvidence = Object.freeze({
      attributeCount: rootAttributes.size,
      unknownAttributeCount: [...rootAttributes.keys()].filter((name) => !recognizedAttributeNames.has(name)).length,
      hashMethodMatches: rootAttributes.get("HashMethod") === blockMapHashMethod,
      namespaceMatches: rootAttributes.get("xmlns") === blockMapNamespace,
      fileHashNamespaceMatches: rootAttributes.get("xmlns:b4") === blockMapFileHashNamespace,
      ignorableNamespacesMatches: rootAttributes.get("IgnorableNamespaces") === "b4",
    });
    throw new Error(`AppxBlockMap.xml has an unexpected hash method or namespace: ${JSON.stringify(publicRootEvidence)}.`);
  }
  const files: AppxBlockMapFile[] = [];
  let body = root[2];
  while (body.trim()) {
    body = body.replace(/^\s+/u, "");
    const file = /^<File([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/File>)/u.exec(body);
    if (!file) throw new Error("AppxBlockMap.xml contains unexpected content.");
    const attributes = parseXmlAttributes(file[1], "AppxBlockMap.xml File");
    if (!exactAttributeKeys(attributes, ["Name", "Size", "LfhSize"])) {
      throw new Error("AppxBlockMap.xml File has unexpected attributes.");
    }
    const name = validateWindowsPackagePath(attributes.get("Name") ?? "", "AppxBlockMap.xml File Name");
    const size = safeIntegerAttribute(attributes.get("Size"), `AppxBlockMap.xml ${name} Size`);
    const localHeaderBytes = safeIntegerAttribute(attributes.get("LfhSize"), `AppxBlockMap.xml ${name} LfhSize`);
    const blocks: { hash: string; compressedBytes: number | null }[] = [];
    let fileHash: string | null = null;
    let children = file[2] ?? "";
    while (children.trim()) {
      children = children.replace(/^\s+/u, "");
      const block = /^<Block([^>]*)\/>/u.exec(children);
      if (block && fileHash === null) {
        const blockAttributes = parseXmlAttributes(block[1], `AppxBlockMap.xml ${name} Block`);
        const keys = [...blockAttributes.keys()];
        if (!(keys.length === 1 && keys[0] === "Hash")
          && !(keys.length === 2 && blockAttributes.has("Hash") && blockAttributes.has("Size"))) {
          throw new Error(`AppxBlockMap.xml File ${name} Block has unexpected attributes.`);
        }
        const hash = blockAttributes.get("Hash") ?? "";
        const decoded = Buffer.from(hash, "base64");
        if (decoded.length !== 32 || decoded.toString("base64") !== hash) {
          throw new Error(`AppxBlockMap.xml File ${name} has an invalid SHA-256 block hash.`);
        }
        const compressedBytes = blockAttributes.has("Size")
          ? safeIntegerAttribute(blockAttributes.get("Size"), `AppxBlockMap.xml ${name} Block Size`)
          : null;
        blocks.push(Object.freeze({ hash, compressedBytes }));
        children = children.slice(block[0].length);
        continue;
      }
      const wholeFileHash = /^<b4:FileHash([^>]*)\/>/u.exec(children);
      if (!fileHashProfile || !wholeFileHash || fileHash !== null) {
        throw new Error(`AppxBlockMap.xml File ${name} contains unexpected content.`);
      }
      const fileHashAttributes = parseXmlAttributes(
        wholeFileHash[1],
        `AppxBlockMap.xml ${name} b4:FileHash`,
      );
      if (!exactAttributeKeys(fileHashAttributes, ["Hash"])) {
        throw new Error(`AppxBlockMap.xml File ${name} b4:FileHash has unexpected attributes.`);
      }
      const candidateFileHash = fileHashAttributes.get("Hash") ?? "";
      const decodedFileHash = Buffer.from(candidateFileHash, "base64");
      if (decodedFileHash.length !== 32 || decodedFileHash.toString("base64") !== candidateFileHash) {
        throw new Error(`AppxBlockMap.xml File ${name} has an invalid whole-file SHA-256 hash.`);
      }
      fileHash = candidateFileHash;
      children = children.slice(wholeFileHash[0].length);
      if (children.trim()) {
        throw new Error(`AppxBlockMap.xml File ${name} b4:FileHash is not terminal.`);
      }
    }
    if (blocks.length !== Math.ceil(size / appxBlockBytes)) {
      throw new Error(`AppxBlockMap.xml File ${name} has an invalid block count.`);
    }
    if (fileHashProfile ? (size > appxBlockBytes) !== (fileHash !== null) : fileHash !== null) {
      throw new Error(`AppxBlockMap.xml File ${name} has invalid b4:FileHash coverage.`);
    }
    files.push(Object.freeze({ name, size, localHeaderBytes, blocks: Object.freeze(blocks), fileHash }));
    body = body.slice(file[0].length);
  }
  assertUniqueWindowsPackagePaths(files.map((file) => file.name), "AppxBlockMap.xml");
  return Object.freeze(files.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name))));
}

function derivedBlockMapCaptureLimit(sources: readonly MsixSourceEntry[]) {
  const blocks = sources.reduce((total, source) => total + Math.ceil(source.bytes / appxBlockBytes), 0);
  const estimated = 4096 + sources.length * 2048 + blocks * 160;
  const ceiling = 128 * 1024 * 1024;
  if (!Number.isSafeInteger(estimated) || estimated > ceiling) {
    throw new Error("Expected AppxBlockMap.xml exceeds the bounded structural-verification budget.");
  }
  return Math.max(1024 * 1024, estimated);
}

function assertBlockMapPreflight(input: Readonly<{
  zipFormat: ZipFormat;
  zipEntries: readonly MsixZipEntry[];
  blockMap: readonly AppxBlockMapFile[];
  sources: readonly MsixSourceEntry[];
}>) {
  const zip = mapByPath(input.zipEntries);
  const blockMap = mapByPath(input.blockMap);
  for (const source of input.sources) {
    const key = windowsPackagePathKey(source.packagePath);
    const entry = zip.get(key);
    const mapped = blockMap.get(key);
    if (!entry || !mapped || entry.name !== source.packagePath || mapped.name !== source.packagePath
      || entry.uncompressedBytes !== source.bytes || mapped.size !== source.bytes
      || mapped.localHeaderBytes !== entry.localHeaderBytes
      || mapped.localHeaderBytes < 30 || mapped.localHeaderBytes > 65_536
      || mapped.blocks.length !== Math.ceil(source.bytes / appxBlockBytes)) {
      throw new Error(`MSIX entry ${source.packagePath} fails size, LFH, or block-count preflight.`);
    }
    if (mapped.fileHash !== null
      && mapped.fileHash !== Buffer.from(source.sha256, "hex").toString("base64")) {
      throw new Error(`MSIX entry ${source.packagePath} has invalid whole-file BlockMap SHA-256 evidence.`);
    }
    if (entry.compressionMethod === 8) {
      const sizes = mapped.blocks.map((block) => block.compressedBytes);
      if (sizes.some((bytes) => bytes === null || bytes <= 0)
        || (input.zipFormat === "zip64-makeappx"
          ? sizes.reduce<number>((total, bytes) => total + (bytes ?? 0), 0) + 2
          : sizes.reduce<number>((total, bytes) => total + (bytes ?? 0), 0)) !== entry.compressedBytes) {
        throw new Error(`Compressed MSIX entry ${source.packagePath} has invalid Block Size evidence.`);
      }
    } else if (mapped.blocks.some((block) => block.compressedBytes !== null)) {
      throw new Error(`Stored MSIX entry ${source.packagePath} must omit Block Size evidence.`);
    }
  }
}

function mapByPath<T extends { name: string }>(entries: readonly T[]) {
  return new Map(entries.map((entry) => [windowsPackagePathKey(entry.name), entry]));
}

function expectedSourceByPath(entries: readonly MsixSourceEntry[]) {
  return new Map(entries.map((entry) => [windowsPackagePathKey(entry.packagePath), entry]));
}

function assertExactPackageInventory(zipEntries: readonly MsixZipEntry[], sources: readonly MsixSourceEntry[]) {
  const expected = [...sources.map((source) => source.packagePath), ...generatedPackageEntries].sort();
  const actual = zipEntries.map((entry) => entry.name).sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error("MSIX does not contain the exact expected application and generated metadata inventory.");
  }
}

function assertExactBlockMapInventory(blockMap: readonly AppxBlockMapFile[], sources: readonly MsixSourceEntry[]) {
  const expected = sources.map((source) => source.packagePath).sort();
  const actual = blockMap.map((entry) => entry.name).sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error("AppxBlockMap.xml does not bind every exact application content file.");
  }
}

export async function verifyUnsignedMsix(input: Readonly<{
  msixPath: string;
  applicationRoot: string;
  manifestPath: string;
  assetsRoot: string;
  checkedOutCommit: string;
  expectedSourceSha: string | null;
}>) {
  const packageEvidence = inspectStableFile(input.msixPath, {
    label: "Unsigned MSIX candidate",
    maximumBytes: MAXIMUM_MSIX_BYTES_EXCLUSIVE,
  });
  if (packageEvidence.bytes >= MAXIMUM_MSIX_BYTES_EXCLUSIVE) {
    throw new Error("MSIX candidate reaches the exact 2 GiB distribution limit.");
  }
  const sources = collectMsixSourceInventory({
    applicationRoot: input.applicationRoot,
    manifestPath: input.manifestPath,
    assetsRoot: input.assetsRoot,
  });
  const manifestIdentity = readExpectedMsixManifestIdentity(input.manifestPath);
  const manifestSource = sources.find((source) => source.packagePath === "AppxManifest.xml");
  if (!manifestSource || manifestSource.sha256 !== APPROVED_MSIX_MANIFEST_SHA256) {
    throw new Error("MSIX manifest source is not the approved internal-candidate contract.");
  }
  const desktopManifestSource = sources.find((source) => source.packagePath === MSIX_DESKTOP_MANIFEST_PACKAGE_PATH);
  if (!desktopManifestSource) throw new Error("MSIX source is missing its desktop provenance manifest.");
  const externalDesktopManifest = inspectStableFile(desktopManifestSource.sourcePath, {
    label: "External desktop provenance manifest",
    maximumBytes: maximumMetadataBytes,
    captureContent: true,
  });
  if (externalDesktopManifest.sha256 !== desktopManifestSource.sha256) {
    throw new Error("Desktop provenance manifest changed after source inventory collection.");
  }
  const desktopManifest = parseDesktopArtifactManifest(JSON.parse(externalDesktopManifest.content?.toString("utf8") ?? ""));
  if (!desktopManifest || desktopManifest.target.platform !== "win32" || desktopManifest.target.arch !== "x64"
    || desktopManifest.sourceDirty || desktopManifest.packagingTooling.signature.mode !== "unsigned-candidate"
    || desktopManifest.sourceCommit !== input.checkedOutCommit
    || (input.expectedSourceSha !== null && input.expectedSourceSha !== input.checkedOutCommit)) {
    throw new Error("Desktop provenance manifest does not bind the exact unsigned win32/x64 source.");
  }
  if (manifestIdentity.version !== msixIdentityVersionForProductVersion(desktopManifest.productVersion)) {
    throw new Error("MSIX package identity does not match the bound desktop product version.");
  }
  const unpackedIdentity = inspectDesktopArtifact({
    resourceRoot: resolve(input.applicationRoot, "resources"),
    manifestPath: desktopManifestSource.sourcePath,
    runtime: {
      platform: "win32",
      arch: "x64",
      electron: desktopManifest.runtimeVersions.electron,
      embeddedNode: desktopManifest.runtimeVersions.embeddedNode,
      next: desktopManifest.runtimeVersions.next,
      nativeModules: desktopManifest.runtimeVersions.nativeModules,
    },
  });
  if (unpackedIdentity.state !== "dirty" || unpackedIdentity.reason !== "distribution-unsigned"
    || unpackedIdentity.manifest?.desktopArtifactId !== desktopManifest.desktopArtifactId) {
    throw new Error(`Final unpacked Windows application identity failed: ${unpackedIdentity.state}/${unpackedIdentity.reason}.`);
  }
  const descriptor = openSync(packageEvidence.path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    assertOpenDescriptorMatchesStableFile(descriptor, packageEvidence, "Unsigned MSIX candidate");
    const opened = fstatSync(descriptor, { bigint: true });
    const zip = parseCentralDirectory(descriptorReader(descriptor, packageEvidence.bytes, "Unsigned MSIX candidate"), "Unsigned MSIX candidate");
    if (zip.format !== "zip64-makeappx") {
      throw new Error("Unsigned MSIX candidate is not the exact pinned MakeAppx ZIP64 profile.");
    }
    const zipByPath = mapByPath(zip.entries);
    if (zipByPath.has(windowsPackagePathKey("AppxSignature.p7x"))) {
      throw new Error("Unsigned MSIX candidate unexpectedly contains AppxSignature.p7x.");
    }
    assertExactPackageInventory(zip.entries, sources);
    const blockMapEntry = zipByPath.get(windowsPackagePathKey("AppxBlockMap.xml"));
    const contentTypesEntry = zipByPath.get(windowsPackagePathKey("[Content_Types].xml"));
    if (!blockMapEntry || !contentTypesEntry) throw new Error("MSIX generated metadata is incomplete.");
    const inspectedContentTypes = await inspectEntry({
      descriptor,
      path: packageEvidence.path,
      entry: contentTypesEntry,
      capture: true,
      maximumCaptureBytes: maximumMetadataBytes,
    });
    const contentTypes = parseMsixContentTypes(
      inspectedContentTypes.content ?? Buffer.alloc(0),
      zip.entries,
    );
    const blockMapCaptureLimit = derivedBlockMapCaptureLimit(sources);
    if (blockMapEntry.uncompressedBytes > blockMapCaptureLimit) {
      throw new Error("AppxBlockMap.xml exceeds the source-derived capture limit.");
    }
    const inspectedBlockMap = await inspectEntry({
      descriptor,
      path: packageEvidence.path,
      entry: blockMapEntry,
      capture: true,
      maximumCaptureBytes: blockMapCaptureLimit,
    });
    const blockMap = parseAppxBlockMap(inspectedBlockMap.content ?? Buffer.alloc(0));
    assertExactBlockMapInventory(blockMap, sources);
    assertBlockMapPreflight({ zipFormat: zip.format, zipEntries: zip.entries, blockMap, sources });
    const blockMapByPath = mapByPath(blockMap);
    const sourceByPath = expectedSourceByPath(sources);
    const verifiedFiles: { path: string; bytes: number; sha256: string; blockCount: number }[] = [];
    for (const entry of zip.entries) {
      const source = sourceByPath.get(windowsPackagePathKey(entry.name));
      if (!source) continue;
      const mapped = blockMapByPath.get(windowsPackagePathKey(entry.name));
      if (!mapped || mapped.name !== entry.name) {
        throw new Error(`MSIX entry ${entry.name} has no exact AppxBlockMap.xml file binding.`);
      }
      const capture = entry.name === "AppxManifest.xml" || entry.name === MSIX_DESKTOP_MANIFEST_PACKAGE_PATH;
      const inspected = await inspectEntry({
        descriptor,
        path: packageEvidence.path,
        entry,
        capture,
        maximumCaptureBytes: maximumMetadataBytes,
        ...(entry.compressionMethod === 8 ? { expectedCompressedBlocks: mapped.blocks } : {}),
      });
      if (inspected.bytes !== source.bytes || inspected.sha256 !== source.sha256) {
        throw new Error(`MSIX entry ${entry.name} does not match its exact source file.`);
      }
      if (mapped.size !== inspected.bytes
        || mapped.localHeaderBytes !== entry.localHeaderBytes
        || mapped.blocks.length !== inspected.blockHashes.length
        || mapped.blocks.some((block, index) => block.hash !== inspected.blockHashes[index])) {
        throw new Error(`MSIX entry ${entry.name} does not reconcile with AppxBlockMap.xml SHA-256 evidence.`);
      }
      if (mapped.fileHash !== null
        && mapped.fileHash !== Buffer.from(inspected.sha256, "hex").toString("base64")) {
        throw new Error(`MSIX entry ${entry.name} does not reconcile with its whole-file BlockMap SHA-256 evidence.`);
      }
      if (entry.name === "AppxManifest.xml" && inspected.sha256 !== APPROVED_MSIX_MANIFEST_SHA256) {
        throw new Error("Packaged AppxManifest.xml is not the approved manifest.");
      }
      if (entry.name === MSIX_DESKTOP_MANIFEST_PACKAGE_PATH
        && inspected.sha256 !== externalDesktopManifest.sha256) {
        throw new Error("Packaged desktop provenance manifest differs from the exact external manifest.");
      }
      verifiedFiles.push({
        path: entry.name,
        bytes: inspected.bytes,
        sha256: inspected.sha256,
        blockCount: inspected.blockHashes.length,
      });
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (after.size !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino
      || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) {
      throw new Error("MSIX candidate changed while its content was verified.");
    }
    assertStableFileUnchanged(packageEvidence, "Unsigned MSIX candidate");
    assertStableFileUnchanged(externalDesktopManifest, "External desktop provenance manifest");
    assertMsixSourceInventoryUnchanged({
      applicationRoot: input.applicationRoot,
      assetsRoot: input.assetsRoot,
      entries: sources,
    });
    const application = verifiedFiles.find((file) => file.path === "RangaBot.exe");
    const packagedDesktopManifest = verifiedFiles.find((file) => file.path === MSIX_DESKTOP_MANIFEST_PACKAGE_PATH);
    if (!application || !packagedDesktopManifest) {
      throw new Error("Verified MSIX evidence is missing its exact application identity files.");
    }
    return Object.freeze({
      distributionTrust: "unsigned-candidate" as const,
      packageSignature: "absent" as const,
      platform: "win32" as const,
      arch: "x64" as const,
      msixBytes: packageEvidence.bytes,
      msixSha256: packageEvidence.sha256,
      zipFormat: zip.format,
      sourceFileCount: sources.length,
      sourceBytes: sources.reduce((total, source) => total + source.bytes, 0),
      verifiedFileCount: verifiedFiles.length,
      blockMapHashMethod: "SHA256" as const,
      blockMapFileCount: blockMap.length,
      blockMapBlockCount: blockMap.reduce((total, file) => total + file.blocks.length, 0),
      blockMapFileHashCount: blockMap.filter((file) => file.fileHash !== null).length,
      contentTypeDefaultCount: contentTypes.defaults.length,
      contentTypeOverrideCount: contentTypes.overrides.length,
      desktopArtifactId: desktopManifest.desktopArtifactId,
      productVersion: desktopManifest.productVersion,
      sourceCommit: desktopManifest.sourceCommit,
      checkedOutCommit: input.checkedOutCommit,
      expectedSourceSha: input.expectedSourceSha,
      manifestIdentity,
      application,
      desktopManifest: packagedDesktopManifest,
    });
  } finally {
    closeSync(descriptor);
  }
}
