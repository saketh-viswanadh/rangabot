import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { basename, resolve } from "node:path";
import { createInflateRaw } from "node:zlib";

const DOS_HEADER_BYTES = 64;
const PE_SIGNATURE_AND_COFF_BYTES = 24;
const PE32_MAGIC = 0x10b;
const X86_MACHINE = 0x014c;
const IMAGE_FILE_LARGE_ADDRESS_AWARE = 0x0020;
const RESOURCE_DIRECTORY_INDEX = 2;
const RESOURCE_TYPE_NAME = "DATA";
const RESOURCE_NAME_ID = 131;
const RESOURCE_LANGUAGE_ID = 0x0409;
const MAXIMUM_PE_HEADER_OFFSET = 16 * 1024 * 1024;
const MAXIMUM_SECTIONS = 96;
const MAXIMUM_RESOURCE_DIRECTORY_ENTRIES = 256;
const MAXIMUM_CENTRAL_DIRECTORY_BYTES = 1024 * 1024;
const MAXIMUM_ZIP_ENTRIES = 16;
const MAXIMUM_NUPKG_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024;
const MAXIMUM_NUPKG_ENTRIES = 65_000;
const MAXIMUM_RELEASES_BYTES = 8192;
const MAXIMUM_DESKTOP_MANIFEST_BYTES = 4 * 1024 * 1024;
const EOCD_MINIMUM_BYTES = 22;
const EOCD_MAXIMUM_BYTES = EOCD_MINIMUM_BYTES + 0xffff;
const EXPECTED_UPDATE_EXE_SHA256 = "76359cd4b0349a83337b941332ad042c90351c2bb0a4628307740324c97984cc";
const EXPECTED_UPDATE_EXE_BYTES = 1_899_520;

type FileIdentity = Readonly<{
  device: bigint;
  inode: bigint;
  links: bigint;
  size: bigint;
  modified: bigint;
  changed: bigint;
}>;

type RandomReader = Readonly<{
  size: number;
  read(offset: number, bytes: number): Buffer;
}>;

type PeSection = Readonly<{
  name: string;
  virtualAddress: number;
  virtualBytes: number;
  rawOffset: number;
  rawBytes: number;
  characteristics: number;
}>;

type PeLauncherShellEvidence = Readonly<{
  headerBytes: number;
  canonicalHeaderSha256: string;
  characteristics: number;
  entryPoint: number;
  imageBase: number;
  sectionAlignment: number;
  fileAlignment: number;
  sizeOfHeaders: number;
  subsystem: number;
  dllCharacteristics: number;
  resourceRelativeOffset: number;
  relocationRelativeOffset: number;
  relocationBytes: number;
  sections: ReadonlyArray<Readonly<{
    name: string;
    virtualBytes: number;
    rawBytes: number;
    characteristics: number;
    sha256: string | null;
  }>>;
}>;

type ResourceEntry = Readonly<{
  name: string | null;
  id: number | null;
  targetOffset: number;
  directory: boolean;
}>;

type ZipCentralEntry = Readonly<{
  name: string;
  directory: boolean;
  flags: number;
  compressionMethod: number;
  crc32: number;
  compressedBytes: number;
  uncompressedBytes: number;
  localHeaderOffset: number;
}>;

type ZipReadPolicy = Readonly<{
  maximumEntries: number;
  maximumCentralDirectoryBytes: number;
  allowPaths: boolean;
  allowDirectoryEntries: boolean;
  allowEmptyFiles: boolean;
}>;

const SQUIRREL_SETUP_ZIP_POLICY: ZipReadPolicy = Object.freeze({
  maximumEntries: MAXIMUM_ZIP_ENTRIES,
  maximumCentralDirectoryBytes: MAXIMUM_CENTRAL_DIRECTORY_BYTES,
  allowPaths: false,
  allowDirectoryEntries: false,
  allowEmptyFiles: false,
});

const SQUIRREL_NUPKG_ZIP_POLICY: ZipReadPolicy = Object.freeze({
  maximumEntries: MAXIMUM_NUPKG_ENTRIES,
  maximumCentralDirectoryBytes: MAXIMUM_NUPKG_CENTRAL_DIRECTORY_BYTES,
  allowPaths: true,
  allowDirectoryEntries: true,
  allowEmptyFiles: true,
});

export type SquirrelPayloadResourceEvidence = Readonly<{
  format: "PE32";
  machine: "i386";
  largeAddressAware: true;
  resourceType: "DATA";
  resourceNameId: 131;
  resourceLanguageId: 1033;
  payloadOffset: number;
  payloadBytes: number;
}>;

export type SquirrelEmbeddedPayloadEvidence = Readonly<{
  setupBytes: number;
  embeddedPayloadOffset: number;
  embeddedPayloadBytes: number;
  embeddedNupkgName: string;
  embeddedNupkgBytes: number;
  embeddedNupkgSha256: string;
  embeddedNupkgSha1: string;
  releases: string;
  externalReleasesMatched: true;
  entries: ReadonlyArray<Readonly<{
    name: string;
    compressedBytes: number;
    uncompressedBytes: number;
    sha256: string;
  }>>;
}>;

export type SquirrelNupkgApplicationEvidence = Readonly<{
  nupkgBytes: number;
  applicationPath: "lib/net45/RangaBot.exe";
  applicationBytes: number;
  applicationSha256: string;
  manifestPath: "lib/net45/resources/rangabot-resources/desktop/manifest.json";
  manifestBytes: number;
  manifestSha256: string;
}>;

function fileIdentity(status: BigIntStats): FileIdentity {
  return Object.freeze({
    device: status.dev,
    inode: status.ino,
    links: status.nlink,
    size: status.size,
    modified: status.mtimeNs,
    changed: status.ctimeNs,
  });
}

function sameIdentity(left: FileIdentity, right: FileIdentity) {
  return left.device === right.device && left.inode === right.inode && left.links === right.links
    && left.size === right.size && left.modified === right.modified && left.changed === right.changed;
}

function canonicalPathMatches(path: string) {
  const canonical = realpathSync(path);
  return process.platform === "win32"
    ? canonical.toLowerCase() === path.toLowerCase()
    : canonical === path;
}

function requireStableRegularFile(path: string, status: BigIntStats, label: string) {
  if (status.isSymbolicLink() || !status.isFile() || status.nlink !== BigInt(1)
    || status.size <= BigInt(0) || status.size > BigInt(Number.MAX_SAFE_INTEGER)
    || !canonicalPathMatches(path)) {
    throw new Error(`${label} must be one stable, non-linked regular file.`);
  }
}

function bufferReader(source: Buffer): RandomReader {
  return Object.freeze({
    size: source.length,
    read(offset: number, bytes: number) {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(bytes) || offset < 0 || bytes < 0
        || offset > source.length - bytes) throw new Error("Synthetic Squirrel Setup is truncated.");
      return source.subarray(offset, offset + bytes);
    },
  });
}

function descriptorReader(descriptor: number, size: number, label: string): RandomReader {
  return Object.freeze({
    size,
    read(offset: number, bytes: number) {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(bytes) || offset < 0 || bytes < 0
        || offset > size - bytes) throw new Error(`${label} is truncated.`);
      const buffer = Buffer.alloc(bytes);
      let cursor = 0;
      while (cursor < bytes) {
        const count = readSync(descriptor, buffer, cursor, bytes - cursor, offset + cursor);
        if (count === 0) throw new Error(`${label} was truncated while it was inspected.`);
        cursor += count;
      }
      return buffer;
    },
  });
}

function isPowerOfTwo(value: number) {
  return Number.isSafeInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

function zeroCanonicalRange(source: Buffer, offset: number, bytes: number, label: string) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(bytes) || offset < 0 || bytes < 0
    || offset > source.length - bytes) {
    throw new Error(`${label} has an out-of-bounds canonical PE-header mask.`);
  }
  source.fill(0, offset, offset + bytes);
}

function inspectPeLauncherShell(reader: RandomReader, label: string): PeLauncherShellEvidence {
  if (reader.size < DOS_HEADER_BYTES) throw new Error(`${label} is not a complete PE image.`);
  const dos = reader.read(0, DOS_HEADER_BYTES);
  if (dos.readUInt16LE(0) !== 0x5a4d) throw new Error(`${label} is missing the MZ header.`);
  const peOffset = dos.readUInt32LE(0x3c);
  if (peOffset < DOS_HEADER_BYTES || peOffset > MAXIMUM_PE_HEADER_OFFSET
    || peOffset > reader.size - PE_SIGNATURE_AND_COFF_BYTES) {
    throw new Error(`${label} has an out-of-bounds PE header.`);
  }
  const peAndCoff = reader.read(peOffset, PE_SIGNATURE_AND_COFF_BYTES);
  if (peAndCoff.readUInt32LE(0) !== 0x00004550 || peAndCoff.readUInt16LE(4) !== X86_MACHINE) {
    throw new Error(`${label} is not the expected PE32/i386 image.`);
  }
  const sectionCount = peAndCoff.readUInt16LE(6);
  const optionalHeaderBytes = peAndCoff.readUInt16LE(20);
  const characteristics = peAndCoff.readUInt16LE(22);
  if (sectionCount < 2 || sectionCount > MAXIMUM_SECTIONS || optionalHeaderBytes < 120
    || characteristics !== 0x0122) {
    throw new Error(`${label} is not the expected large-address-aware Squirrel PE32 image.`);
  }
  const optionalHeaderOffset = peOffset + PE_SIGNATURE_AND_COFF_BYTES;
  if (optionalHeaderOffset > reader.size - optionalHeaderBytes) throw new Error(`${label} has a truncated optional header.`);
  const optional = reader.read(optionalHeaderOffset, optionalHeaderBytes);
  if (optional.readUInt16LE(0) !== PE32_MAGIC) throw new Error(`${label} is not a PE32 image.`);
  const entryPoint = optional.readUInt32LE(16);
  const imageBase = optional.readUInt32LE(28);
  const sectionAlignment = optional.readUInt32LE(32);
  const fileAlignment = optional.readUInt32LE(36);
  const sizeOfImage = optional.readUInt32LE(56);
  const sizeOfHeaders = optional.readUInt32LE(60);
  const subsystem = optional.readUInt16LE(68);
  const dllCharacteristics = optional.readUInt16LE(70);
  if (entryPoint === 0 || imageBase === 0 || !isPowerOfTwo(sectionAlignment)
    || !isPowerOfTwo(fileAlignment) || fileAlignment < 0x200 || sectionAlignment < fileAlignment
    || sizeOfHeaders === 0 || sizeOfHeaders > reader.size || subsystem !== 2) {
    throw new Error(`${label} does not have a runnable Windows GUI launcher header.`);
  }
  const sectionTableOffset = optionalHeaderOffset + optionalHeaderBytes;
  const sectionTableBytes = sectionCount * 40;
  if (sectionTableOffset > reader.size - sectionTableBytes || sizeOfHeaders < sectionTableOffset + sectionTableBytes) {
    throw new Error(`${label} has a truncated section table.`);
  }
  const sectionTable = reader.read(sectionTableOffset, sectionTableBytes);
  const sections: Array<PeSection & Readonly<{ sha256: string | null }>> = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = index * 40;
    const name = sectionTable.subarray(offset, offset + 8).toString("ascii").replace(/\0+$/u, "");
    const virtualBytes = sectionTable.readUInt32LE(offset + 8);
    const rawBytes = sectionTable.readUInt32LE(offset + 16);
    const rawOffset = sectionTable.readUInt32LE(offset + 20);
    const sectionCharacteristics = sectionTable.readUInt32LE(offset + 36);
    const virtualAddress = sectionTable.readUInt32LE(offset + 12);
    if (!/^\.[A-Za-z0-9]+$/u.test(name) || virtualBytes === 0 || rawBytes === 0
      || virtualAddress % sectionAlignment !== 0 || rawOffset % fileAlignment !== 0
      || rawBytes % fileAlignment !== 0 || rawOffset < sizeOfHeaders
      || rawOffset > reader.size - rawBytes) {
      throw new Error(`${label} has an invalid PE section.`);
    }
    sections.push(Object.freeze({
      name,
      virtualBytes,
      virtualAddress,
      rawBytes,
      rawOffset,
      characteristics: sectionCharacteristics,
      sha256: name === ".rsrc" ? null : createHash("sha256").update(reader.read(rawOffset, rawBytes)).digest("hex"),
    }));
  }
  if (new Set(sections.map((section) => section.name)).size !== sections.length
    || sections.filter((section) => section.name === ".text").length !== 1
    || sections.filter((section) => section.name === ".rsrc").length !== 1) {
    throw new Error(`${label} does not have the exact required launcher section identities.`);
  }
  const orderedByVirtualAddress = [...sections].sort((left, right) => left.virtualAddress - right.virtualAddress);
  const orderedByRawOffset = [...sections].sort((left, right) => left.rawOffset - right.rawOffset);
  for (let index = 1; index < sections.length; index += 1) {
    const previousVirtual = orderedByVirtualAddress[index - 1];
    const currentVirtual = orderedByVirtualAddress[index];
    const previousRaw = orderedByRawOffset[index - 1];
    const currentRaw = orderedByRawOffset[index];
    if (previousVirtual.virtualAddress + Math.max(previousVirtual.virtualBytes, previousVirtual.rawBytes)
        > currentVirtual.virtualAddress
      || previousRaw.rawOffset + previousRaw.rawBytes > currentRaw.rawOffset) {
      throw new Error(`${label} has overlapping PE sections.`);
    }
  }
  const finalRawEnd = Math.max(...sections.map((section) => section.rawOffset + section.rawBytes));
  if (finalRawEnd !== reader.size) throw new Error(`${label} has an unsupported PE overlay.`);
  const maximumVirtualEnd = Math.max(...sections.map((section) => section.virtualAddress + section.virtualBytes));
  const expectedSizeOfImage = Math.ceil(maximumVirtualEnd / sectionAlignment) * sectionAlignment;
  if (!Number.isSafeInteger(expectedSizeOfImage) || sizeOfImage !== expectedSizeOfImage) {
    throw new Error(`${label} has an invalid PE SizeOfImage.`);
  }
  const text = sections.find((section) => section.name === ".text")!;
  const entryPointSections = sections.filter((section) => entryPoint >= section.virtualAddress
    && entryPoint < section.virtualAddress + Math.max(section.virtualBytes, section.rawBytes));
  if (entryPointSections.length !== 1 || entryPointSections[0] !== text) {
    throw new Error(`${label} entry point is not uniquely contained in its .text section.`);
  }
  const directoryCount = optional.readUInt32LE(92);
  const maximumDirectoryCount = Math.floor((optionalHeaderBytes - 96) / 8);
  if (directoryCount > maximumDirectoryCount || directoryCount <= 5) {
    throw new Error(`${label} does not contain the required PE data directories.`);
  }
  const securityOffset = optional.readUInt32LE(128);
  const securityBytes = optional.readUInt32LE(132);
  if (securityOffset !== 0 || securityBytes !== 0) {
    throw new Error(`${label} contains an embedded PE certificate table.`);
  }
  const resourceRva = optional.readUInt32LE(112);
  const resourceBytes = optional.readUInt32LE(116);
  const relocationRva = optional.readUInt32LE(136);
  const relocationBytes = optional.readUInt32LE(140);
  const resource = sections.find((section) => section.name === ".rsrc")!;
  const relocation = sections.find((section) => section.name === ".reloc");
  if (!relocation || resourceRva < resource.virtualAddress
    || resourceRva > resource.virtualAddress + resource.rawBytes - resourceBytes
    || relocationRva < relocation.virtualAddress
    || relocationRva > relocation.virtualAddress + relocation.rawBytes - relocationBytes
    || resourceBytes === 0 || relocationBytes === 0) {
    throw new Error(`${label} has resource or relocation evidence outside its declared PE section.`);
  }

  const canonicalHeader = Buffer.from(reader.read(0, sizeOfHeaders));
  for (const [offset, bytes] of [
    [optionalHeaderOffset + 8, 4],
    [optionalHeaderOffset + 56, 4],
    [optionalHeaderOffset + 64, 4],
    [optionalHeaderOffset + 112, 8],
    [optionalHeaderOffset + 136, 4],
  ] as const) zeroCanonicalRange(canonicalHeader, offset, bytes, label);
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    const recordOffset = sectionTableOffset + index * 40;
    if (section.name === ".rsrc") zeroCanonicalRange(canonicalHeader, recordOffset + 8, 16, label);
    if (section.name === ".reloc") {
      zeroCanonicalRange(canonicalHeader, recordOffset + 12, 4, label);
      zeroCanonicalRange(canonicalHeader, recordOffset + 20, 4, label);
    }
  }
  return Object.freeze({
    headerBytes: sizeOfHeaders,
    canonicalHeaderSha256: createHash("sha256").update(canonicalHeader).digest("hex"),
    characteristics,
    entryPoint,
    imageBase,
    sectionAlignment,
    fileAlignment,
    sizeOfHeaders,
    subsystem,
    dllCharacteristics,
    resourceRelativeOffset: resourceRva - resource.virtualAddress,
    relocationRelativeOffset: relocationRva - relocation.virtualAddress,
    relocationBytes,
    sections: Object.freeze(sections.map((section) => Object.freeze({
      name: section.name,
      virtualBytes: section.virtualBytes,
      rawBytes: section.rawBytes,
      characteristics: section.characteristics,
      sha256: section.sha256,
    }))),
  });
}

function inspectStablePeLauncherShell(pathInput: string, label: string) {
  const path = resolve(pathInput);
  const before = lstatSync(path, { bigint: true });
  requireStableRegularFile(path, before, label);
  const identity = fileIdentity(before);
  const descriptor = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(identity, fileIdentity(opened))) throw new Error(`${label} changed while it was opened.`);
    const evidence = inspectPeLauncherShell(descriptorReader(descriptor, Number(opened.size), label), label);
    const afterRead = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    if (!sameIdentity(identity, fileIdentity(afterRead)) || !sameIdentity(identity, fileIdentity(afterPath))) {
      throw new Error(`${label} changed while it was inspected.`);
    }
    return evidence;
  } finally {
    closeSync(descriptor);
  }
}

function requireMatchingPeLauncherShell(
  candidate: PeLauncherShellEvidence,
  template: PeLauncherShellEvidence,
  label: string,
) {
  for (const field of [
    "headerBytes",
    "canonicalHeaderSha256",
    "characteristics",
    "entryPoint",
    "imageBase",
    "sectionAlignment",
    "fileAlignment",
    "sizeOfHeaders",
    "subsystem",
    "dllCharacteristics",
    "resourceRelativeOffset",
    "relocationRelativeOffset",
    "relocationBytes",
  ] as const) {
    if (candidate[field] !== template[field]) throw new Error(`${label} does not match the locked Squirrel launcher header.`);
  }
  if (candidate.sections.length !== template.sections.length
    || candidate.sections.some((section, index) => {
      const expected = template.sections[index];
      return section.name !== expected.name
        || (section.name !== ".rsrc" && (
          section.virtualBytes !== expected.virtualBytes
          || section.rawBytes !== expected.rawBytes
          || section.characteristics !== expected.characteristics
          || section.sha256 !== expected.sha256
        ));
    })) {
    throw new Error(`${label} does not match the locked Squirrel launcher code sections.`);
  }
}

function mapRvaToFileOffset(sections: readonly PeSection[], rva: number, bytes: number, fileBytes: number, label: string) {
  if (!Number.isSafeInteger(rva) || !Number.isSafeInteger(bytes) || rva < 0 || bytes < 0) {
    throw new Error(`${label} has an invalid PE resource address.`);
  }
  const matches = sections.filter((section) => {
    const span = Math.max(section.virtualBytes, section.rawBytes);
    return rva >= section.virtualAddress && rva < section.virtualAddress + span;
  });
  if (matches.length !== 1) throw new Error(`${label} has an ambiguous PE resource address.`);
  const section = matches[0];
  const delta = rva - section.virtualAddress;
  if (delta > section.rawBytes - bytes || section.rawOffset > fileBytes - delta - bytes) {
    throw new Error(`${label} has a PE resource outside its raw section data.`);
  }
  return section.rawOffset + delta;
}

function readResourceName(reader: RandomReader, resourceBase: number, resourceBytes: number, relativeOffset: number, label: string) {
  if (relativeOffset < 0 || relativeOffset > resourceBytes - 2) throw new Error(`${label} has an invalid resource name.`);
  const length = reader.read(resourceBase + relativeOffset, 2).readUInt16LE(0);
  const bytes = length * 2;
  if (length === 0 || length > 256 || relativeOffset + 2 > resourceBytes - bytes) {
    throw new Error(`${label} has an invalid resource name.`);
  }
  return reader.read(resourceBase + relativeOffset + 2, bytes).toString("utf16le");
}

function compareUtf16CodeUnits(left: string, right: string) {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function readResourceDirectory(
  reader: RandomReader,
  resourceBase: number,
  resourceBytes: number,
  relativeOffset: number,
  label: string,
): readonly ResourceEntry[] {
  if (relativeOffset < 0 || relativeOffset > resourceBytes - 16) throw new Error(`${label} has an invalid resource directory.`);
  const header = reader.read(resourceBase + relativeOffset, 16);
  const named = header.readUInt16LE(12);
  const identified = header.readUInt16LE(14);
  const count = named + identified;
  if (count === 0 || count > MAXIMUM_RESOURCE_DIRECTORY_ENTRIES
    || relativeOffset + 16 > resourceBytes - count * 8) {
    throw new Error(`${label} has an invalid resource directory.`);
  }
  const records = reader.read(resourceBase + relativeOffset + 16, count * 8);
  const entries: ResourceEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const nameField = records.readUInt32LE(index * 8);
    const targetField = records.readUInt32LE(index * 8 + 4);
    const stringNamed = (nameField & 0x80000000) !== 0;
    if (stringNamed !== (index < named)) {
      throw new Error(`${label} has a malformed named/resource-ID partition.`);
    }
    const nameOffset = nameField & 0x7fffffff;
    const targetOffset = targetField & 0x7fffffff;
    if (targetOffset >= resourceBytes) throw new Error(`${label} has an out-of-bounds resource target.`);
    entries.push(Object.freeze({
      name: stringNamed
        ? readResourceName(reader, resourceBase, resourceBytes, nameOffset, label)
        : null,
      id: stringNamed ? null : nameField,
      targetOffset,
      directory: (targetField & 0x80000000) !== 0,
    }));
  }
  for (let index = 1; index < named; index += 1) {
    const previous = entries[index - 1].name;
    const current = entries[index].name;
    if (previous === null || current === null || compareUtf16CodeUnits(previous, current) >= 0) {
      throw new Error(`${label} has resource names that are not strictly sorted and unique.`);
    }
  }
  for (let index = named + 1; index < entries.length; index += 1) {
    const previous = entries[index - 1].id;
    const current = entries[index].id;
    if (previous === null || current === null || previous >= current) {
      throw new Error(`${label} has resource IDs that are not strictly sorted and unique.`);
    }
  }
  return Object.freeze(entries);
}

function uniqueResourceEntry(entries: readonly ResourceEntry[], predicate: (entry: ResourceEntry) => boolean, label: string) {
  const matches = entries.filter(predicate);
  if (matches.length !== 1) throw new Error(`${label} does not contain one exact Squirrel payload resource.`);
  return matches[0];
}

function locateSquirrelPayloadResource(reader: RandomReader, label: string): SquirrelPayloadResourceEvidence {
  if (reader.size < DOS_HEADER_BYTES) throw new Error(`${label} is not a complete PE image.`);
  const dos = reader.read(0, DOS_HEADER_BYTES);
  if (dos.readUInt16LE(0) !== 0x5a4d) throw new Error(`${label} is missing the MZ header.`);
  const peOffset = dos.readUInt32LE(0x3c);
  if (peOffset < DOS_HEADER_BYTES || peOffset > MAXIMUM_PE_HEADER_OFFSET
    || peOffset > reader.size - PE_SIGNATURE_AND_COFF_BYTES) {
    throw new Error(`${label} has an out-of-bounds PE header.`);
  }
  const peAndCoff = reader.read(peOffset, PE_SIGNATURE_AND_COFF_BYTES);
  if (peAndCoff.readUInt32LE(0) !== 0x00004550 || peAndCoff.readUInt16LE(4) !== X86_MACHINE) {
    throw new Error(`${label} is not the expected PE32/i386 image.`);
  }
  const sectionCount = peAndCoff.readUInt16LE(6);
  const optionalHeaderBytes = peAndCoff.readUInt16LE(20);
  const characteristics = peAndCoff.readUInt16LE(22);
  if (sectionCount === 0 || sectionCount > MAXIMUM_SECTIONS || optionalHeaderBytes < 120
    || (characteristics & IMAGE_FILE_LARGE_ADDRESS_AWARE) === 0) {
    throw new Error(`${label} is not the expected large-address-aware PE32 image.`);
  }
  const optionalHeaderOffset = peOffset + PE_SIGNATURE_AND_COFF_BYTES;
  if (optionalHeaderOffset > reader.size - optionalHeaderBytes) throw new Error(`${label} has a truncated optional header.`);
  const optional = reader.read(optionalHeaderOffset, optionalHeaderBytes);
  if (optional.readUInt16LE(0) !== PE32_MAGIC) throw new Error(`${label} is not a PE32 image.`);
  const directoryCount = optional.readUInt32LE(92);
  const maximumDirectoryCount = Math.floor((optionalHeaderBytes - 96) / 8);
  if (directoryCount > maximumDirectoryCount || directoryCount <= RESOURCE_DIRECTORY_INDEX) {
    throw new Error(`${label} does not declare a valid resource directory.`);
  }
  const resourceRva = optional.readUInt32LE(96 + RESOURCE_DIRECTORY_INDEX * 8);
  const resourceBytes = optional.readUInt32LE(96 + RESOURCE_DIRECTORY_INDEX * 8 + 4);
  if (resourceRva === 0 || resourceBytes < 64) throw new Error(`${label} has no usable resource directory.`);
  const sectionTableOffset = optionalHeaderOffset + optionalHeaderBytes;
  const sectionTableBytes = sectionCount * 40;
  if (sectionTableOffset > reader.size - sectionTableBytes) throw new Error(`${label} has a truncated section table.`);
  const sectionTable = reader.read(sectionTableOffset, sectionTableBytes);
  const sections: PeSection[] = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = index * 40;
    const section = Object.freeze({
      name: sectionTable.subarray(offset, offset + 8).toString("ascii").replace(/\0+$/u, ""),
      virtualBytes: sectionTable.readUInt32LE(offset + 8),
      virtualAddress: sectionTable.readUInt32LE(offset + 12),
      rawBytes: sectionTable.readUInt32LE(offset + 16),
      rawOffset: sectionTable.readUInt32LE(offset + 20),
      characteristics: sectionTable.readUInt32LE(offset + 36),
    });
    if (section.rawBytes > 0 && section.rawOffset > reader.size - section.rawBytes) {
      throw new Error(`${label} has an out-of-bounds PE section.`);
    }
    sections.push(section);
  }
  const resourceBase = mapRvaToFileOffset(sections, resourceRva, resourceBytes, reader.size, label);
  const type = uniqueResourceEntry(
    readResourceDirectory(reader, resourceBase, resourceBytes, 0, label),
    (entry) => entry.name === RESOURCE_TYPE_NAME && entry.directory,
    label,
  );
  const name = uniqueResourceEntry(
    readResourceDirectory(reader, resourceBase, resourceBytes, type.targetOffset, label),
    (entry) => entry.id === RESOURCE_NAME_ID && entry.directory,
    label,
  );
  const languageEntries = readResourceDirectory(reader, resourceBase, resourceBytes, name.targetOffset, label);
  if (languageEntries.length !== 1) {
    throw new Error(`${label} must contain exactly one Squirrel payload language resource.`);
  }
  const language = uniqueResourceEntry(
    languageEntries,
    (entry) => entry.id === RESOURCE_LANGUAGE_ID && !entry.directory,
    label,
  );
  if (language.targetOffset > resourceBytes - 16) throw new Error(`${label} has an invalid Squirrel payload descriptor.`);
  const data = reader.read(resourceBase + language.targetOffset, 16);
  const payloadRva = data.readUInt32LE(0);
  const payloadBytes = data.readUInt32LE(4);
  if (payloadBytes < EOCD_MINIMUM_BYTES || payloadRva < resourceRva
    || payloadRva > resourceRva + resourceBytes - payloadBytes) {
    throw new Error(`${label} has an invalid Squirrel payload range.`);
  }
  const payloadOffset = mapRvaToFileOffset(sections, payloadRva, payloadBytes, reader.size, label);
  return Object.freeze({
    format: "PE32",
    machine: "i386",
    largeAddressAware: true,
    resourceType: RESOURCE_TYPE_NAME,
    resourceNameId: RESOURCE_NAME_ID,
    resourceLanguageId: RESOURCE_LANGUAGE_ID,
    payloadOffset,
    payloadBytes,
  });
}

export function inspectSquirrelPayloadResourceBuffer(source: Buffer, label = "Squirrel Setup.exe") {
  return locateSquirrelPayloadResource(bufferReader(source), label);
}

function findEndOfCentralDirectory(
  reader: RandomReader,
  payload: SquirrelPayloadResourceEvidence,
  label: string,
  policy: ZipReadPolicy = SQUIRREL_SETUP_ZIP_POLICY,
) {
  const tailBytes = Math.min(payload.payloadBytes, EOCD_MAXIMUM_BYTES);
  const tailOffset = payload.payloadOffset + payload.payloadBytes - tailBytes;
  const tail = reader.read(tailOffset, tailBytes);
  for (let index = tail.length - EOCD_MINIMUM_BYTES; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) !== 0x06054b50) continue;
    const commentBytes = tail.readUInt16LE(index + 20);
    if (index + EOCD_MINIMUM_BYTES + commentBytes !== tail.length) continue;
    const disk = tail.readUInt16LE(index + 4);
    const centralDisk = tail.readUInt16LE(index + 6);
    const diskEntries = tail.readUInt16LE(index + 8);
    const totalEntries = tail.readUInt16LE(index + 10);
    const centralBytes = tail.readUInt32LE(index + 12);
    const centralOffset = tail.readUInt32LE(index + 16);
    const endOffset = payload.payloadBytes - tailBytes + index;
    if (commentBytes !== 0 || disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries
      || totalEntries === 0 || totalEntries > policy.maximumEntries
      || centralBytes === 0 || centralBytes > policy.maximumCentralDirectoryBytes
      || centralOffset > payload.payloadBytes - centralBytes
      || centralOffset + centralBytes !== endOffset) {
      throw new Error(`${label} has an invalid embedded ZIP central directory.`);
    }
    return Object.freeze({ totalEntries, centralBytes, centralOffset, endOffset });
  }
  throw new Error(`${label} has no complete embedded ZIP end record.`);
}

function decodeZipName(source: Buffer, flags: number, label: string, allowPaths = false) {
  if ((flags & 0x0800) === 0 && source.some((value) => value > 0x7f)) {
    throw new Error(`${label} has a non-UTF-8 embedded ZIP name.`);
  }
  const name = source.toString("utf8");
  const pathSegments = name.split("/");
  const trailingDirectory = allowPaths && name.endsWith("/");
  const checkedSegments = trailingDirectory ? pathSegments.slice(0, -1) : pathSegments;
  if (!name || name.includes("\\") || name.includes("\0") || name.startsWith("/")
    || (!allowPaths && name.includes("/"))
    || checkedSegments.length === 0
    || checkedSegments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} has an unsafe embedded ZIP entry name.`);
  }
  return name;
}

function readZipCentralEntries(
  reader: RandomReader,
  payload: SquirrelPayloadResourceEvidence,
  label: string,
  policy: ZipReadPolicy = SQUIRREL_SETUP_ZIP_POLICY,
): readonly ZipCentralEntry[] {
  const end = findEndOfCentralDirectory(reader, payload, label, policy);
  const central = reader.read(payload.payloadOffset + end.centralOffset, end.centralBytes);
  const entries: ZipCentralEntry[] = [];
  let offset = 0;
  while (offset < central.length) {
    if (offset > central.length - 46 || central.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`${label} has a malformed embedded ZIP central entry.`);
    }
    const flags = central.readUInt16LE(offset + 8);
    const compressionMethod = central.readUInt16LE(offset + 10);
    const crc32 = central.readUInt32LE(offset + 16);
    const compressedBytes = central.readUInt32LE(offset + 20);
    const uncompressedBytes = central.readUInt32LE(offset + 24);
    const nameBytes = central.readUInt16LE(offset + 28);
    const extraBytes = central.readUInt16LE(offset + 30);
    const commentBytes = central.readUInt16LE(offset + 32);
    const disk = central.readUInt16LE(offset + 34);
    const localHeaderOffset = central.readUInt32LE(offset + 42);
    const recordBytes = 46 + nameBytes + extraBytes + commentBytes;
    const name = decodeZipName(
      central.subarray(offset + 46, offset + 46 + nameBytes),
      flags,
      label,
      policy.allowPaths,
    );
    const directory = name.endsWith("/");
    if (recordBytes > central.length - offset || disk !== 0 || nameBytes === 0
      || compressedBytes === 0xffffffff || uncompressedBytes === 0xffffffff || localHeaderOffset === 0xffffffff
      || (!directory && !policy.allowEmptyFiles && (compressedBytes === 0 || uncompressedBytes === 0))
      || (directory && !policy.allowDirectoryEntries)
      || (directory && (compressedBytes !== 0 || uncompressedBytes !== 0))
      || (flags & ~0x0808) !== 0 || (compressionMethod !== 0 && compressionMethod !== 8)) {
      throw new Error(`${label} has an unsupported embedded ZIP entry.`);
    }
    entries.push(Object.freeze({
      name,
      directory,
      flags,
      compressionMethod,
      crc32,
      compressedBytes,
      uncompressedBytes,
      localHeaderOffset,
    }));
    offset += recordBytes;
  }
  if (offset !== central.length || entries.length !== end.totalEntries
    || new Set(entries.map((entry) => entry.name)).size !== entries.length) {
    throw new Error(`${label} has an inconsistent embedded ZIP directory.`);
  }
  return Object.freeze(entries);
}

const CRC_TABLE = Object.freeze(Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
}));

function updateCrc32(crc: number, source: Buffer) {
  let value = crc;
  for (const byte of source) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return value >>> 0;
}

async function inspectZipEntry(input: {
  descriptor: number;
  setupPath: string;
  reader: RandomReader;
  payload: SquirrelPayloadResourceEvidence;
  centralOffset: number;
  expectedEndOffset: number;
  entry: ZipCentralEntry;
  capture: boolean;
  maximumCaptureBytes: number;
  allowPaths: boolean;
  label: string;
}) {
  const localOffset = input.payload.payloadOffset + input.entry.localHeaderOffset;
  if (input.entry.localHeaderOffset > input.centralOffset - 30) {
    throw new Error(`${input.label} has an invalid embedded ZIP local header.`);
  }
  const local = input.reader.read(localOffset, 30);
  if (local.readUInt32LE(0) !== 0x04034b50
    || local.readUInt16LE(6) !== input.entry.flags
    || local.readUInt16LE(8) !== input.entry.compressionMethod) {
    throw new Error(`${input.label} has an inconsistent embedded ZIP local header.`);
  }
  if ((input.entry.flags & 0x0008) === 0
    && (local.readUInt32LE(14) !== input.entry.crc32
      || local.readUInt32LE(18) !== input.entry.compressedBytes
      || local.readUInt32LE(22) !== input.entry.uncompressedBytes)) {
    throw new Error(`${input.label} has mismatched embedded ZIP local evidence.`);
  }
  const nameBytes = local.readUInt16LE(26);
  const extraBytes = local.readUInt16LE(28);
  const localName = decodeZipName(
    input.reader.read(localOffset + 30, nameBytes),
    input.entry.flags,
    input.label,
    input.allowPaths,
  );
  if (localName !== input.entry.name) throw new Error(`${input.label} has mismatched embedded ZIP names.`);
  const dataOffset = input.entry.localHeaderOffset + 30 + nameBytes + extraBytes;
  if (dataOffset > input.expectedEndOffset - input.entry.compressedBytes) {
    throw new Error(`${input.label} has an out-of-bounds embedded ZIP body.`);
  }
  const bodyEndOffset = dataOffset + input.entry.compressedBytes;
  const trailingBytes = input.expectedEndOffset - bodyEndOffset;
  if ((input.entry.flags & 0x0008) === 0) {
    if (trailingBytes !== 0) throw new Error(`${input.label} has an unexplained embedded ZIP gap.`);
  } else {
    if (trailingBytes !== 12 && trailingBytes !== 16) {
      throw new Error(`${input.label} has an invalid embedded ZIP data descriptor.`);
    }
    const descriptor = input.reader.read(
      input.payload.payloadOffset + bodyEndOffset,
      trailingBytes,
    );
    const valueOffset = trailingBytes === 16 ? 4 : 0;
    if ((trailingBytes === 16 && descriptor.readUInt32LE(0) !== 0x08074b50)
      || descriptor.readUInt32LE(valueOffset) !== input.entry.crc32
      || descriptor.readUInt32LE(valueOffset + 4) !== input.entry.compressedBytes
      || descriptor.readUInt32LE(valueOffset + 8) !== input.entry.uncompressedBytes) {
      throw new Error(`${input.label} has mismatched embedded ZIP data-descriptor evidence.`);
    }
  }
  const absoluteStart = input.payload.payloadOffset + dataOffset;
  const raw = createReadStream(input.setupPath, {
    fd: input.descriptor,
    autoClose: false,
    start: absoluteStart,
    end: absoluteStart + input.entry.compressedBytes - 1,
  });
  const stream = input.entry.compressionMethod === 8 ? raw.pipe(createInflateRaw()) : raw;
  if (stream !== raw) raw.on("error", (error) => stream.destroy(error));
  const sha256 = createHash("sha256");
  const sha1 = createHash("sha1");
  const captured: Buffer[] = [];
  let bytes = 0;
  let crc = 0xffffffff;
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    bytes += chunk.length;
    if (bytes > input.entry.uncompressedBytes) throw new Error(`${input.label} expanded past its declared ZIP size.`);
    sha256.update(chunk);
    sha1.update(chunk);
    crc = updateCrc32(crc, chunk);
    if (input.capture) {
      if (bytes > input.maximumCaptureBytes) throw new Error(`${input.label} metadata is unexpectedly large.`);
      captured.push(Buffer.from(chunk));
    }
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  if (bytes !== input.entry.uncompressedBytes || crc !== input.entry.crc32) {
    throw new Error(`${input.label} has invalid embedded ZIP size or CRC evidence.`);
  }
  return Object.freeze({
    name: input.entry.name,
    compressedBytes: input.entry.compressedBytes,
    uncompressedBytes: bytes,
    sha256: sha256.digest("hex"),
    sha1: sha1.digest("hex"),
    ...(input.capture ? { content: Buffer.concat(captured) } : {}),
  });
}

export async function verifySquirrelSetupEmbeddedPayload(input: {
  setupPath: string;
  setupTemplatePath: string;
  nupkgPath: string;
  expectedNupkgBytes: number;
  expectedNupkgSha256: string;
  expectedReleases: string;
}): Promise<SquirrelEmbeddedPayloadEvidence> {
  const setupPath = resolve(input.setupPath);
  const templateShell = inspectStablePeLauncherShell(input.setupTemplatePath, "Locked Squirrel Setup template");
  const nupkgName = basename(resolve(input.nupkgPath));
  if (!/^RangaBot-\d+\.\d+\.\d+-full\.nupkg$/.test(nupkgName)
    || !Number.isSafeInteger(input.expectedNupkgBytes) || input.expectedNupkgBytes <= 0
    || !/^[0-9a-f]{64}$/.test(input.expectedNupkgSha256)
    || typeof input.expectedReleases !== "string"
    || Buffer.byteLength(input.expectedReleases, "utf8") > MAXIMUM_RELEASES_BYTES) {
    throw new Error("The expected Squirrel package evidence is invalid.");
  }
  const expectedReleases = input.expectedReleases.trim();
  if (!expectedReleases) throw new Error("The expected Squirrel RELEASES evidence is invalid.");
  const before = lstatSync(setupPath, { bigint: true });
  requireStableRegularFile(setupPath, before, "Squirrel Setup.exe");
  const identity = fileIdentity(before);
  const descriptor = openSync(setupPath, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(identity, fileIdentity(opened))) throw new Error("Squirrel Setup.exe changed while it was opened.");
    const reader = descriptorReader(descriptor, Number(opened.size), "Squirrel Setup.exe");
    requireMatchingPeLauncherShell(
      inspectPeLauncherShell(reader, "Squirrel Setup.exe"),
      templateShell,
      "Squirrel Setup.exe",
    );
    const payload = locateSquirrelPayloadResource(reader, "Squirrel Setup.exe");
    const end = findEndOfCentralDirectory(reader, payload, "Squirrel Setup.exe");
    const centralEntries = readZipCentralEntries(reader, payload, "Squirrel Setup.exe");
    const expectedNames = new Set([nupkgName, "Update.exe", "RELEASES", "background.gif", "setupIcon.ico"]);
    if (centralEntries.length !== expectedNames.size
      || centralEntries.some((entry) => !expectedNames.has(entry.name))) {
      throw new Error("Squirrel Setup.exe does not contain the exact expected embedded files.");
    }
    const layoutEntries = [...centralEntries].sort((left, right) => left.localHeaderOffset - right.localHeaderOffset);
    if (layoutEntries[0]?.localHeaderOffset !== 0
      || new Set(layoutEntries.map((entry) => entry.localHeaderOffset)).size !== layoutEntries.length) {
      throw new Error("Squirrel Setup.exe has an invalid embedded ZIP local layout.");
    }
    const inspected = [];
    for (let index = 0; index < layoutEntries.length; index += 1) {
      const entry = layoutEntries[index];
      const expectedEndOffset = layoutEntries[index + 1]?.localHeaderOffset ?? end.centralOffset;
      if (expectedEndOffset <= entry.localHeaderOffset) {
        throw new Error("Squirrel Setup.exe has overlapping embedded ZIP entries.");
      }
      inspected.push(await inspectZipEntry({
        descriptor,
        setupPath,
        reader,
        payload,
        centralOffset: end.centralOffset,
        expectedEndOffset,
        entry,
        capture: entry.name === "RELEASES",
        maximumCaptureBytes: MAXIMUM_RELEASES_BYTES,
        allowPaths: false,
        label: `Squirrel Setup.exe entry ${entry.name}`,
      }));
    }
    const nupkg = inspected.find((entry) => entry.name === nupkgName);
    const update = inspected.find((entry) => entry.name === "Update.exe");
    const releasesEntry = inspected.find((entry) => entry.name === "RELEASES");
    if (!nupkg || nupkg.uncompressedBytes !== input.expectedNupkgBytes
      || nupkg.sha256 !== input.expectedNupkgSha256) {
      throw new Error("Squirrel Setup.exe does not embed the exact generated full package.");
    }
    if (!update || update.uncompressedBytes !== EXPECTED_UPDATE_EXE_BYTES
      || update.sha256 !== EXPECTED_UPDATE_EXE_SHA256) {
      throw new Error("Squirrel Setup.exe does not embed the locked Squirrel updater.");
    }
    const releases = Buffer.isBuffer(releasesEntry?.content)
      ? releasesEntry.content.toString("utf8").trim()
      : "";
    const releaseMatch = /^([0-9a-f]{40})\s+(\S+)\s+(\d+)$/i.exec(releases);
    if (!releaseMatch || releaseMatch[1].toLowerCase() !== nupkg.sha1
      || releaseMatch[2] !== nupkgName || Number(releaseMatch[3]) !== nupkg.uncompressedBytes) {
      throw new Error("Squirrel Setup.exe has inconsistent embedded RELEASES evidence.");
    }
    if (releases !== expectedReleases) {
      throw new Error("Squirrel Setup.exe embedded RELEASES does not match the external Squirrel RELEASES file.");
    }
    const afterRead = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(setupPath, { bigint: true });
    if (!sameIdentity(identity, fileIdentity(afterRead)) || !sameIdentity(identity, fileIdentity(afterPath))) {
      throw new Error("Squirrel Setup.exe changed while its embedded payload was inspected.");
    }
    return Object.freeze({
      setupBytes: Number(opened.size),
      embeddedPayloadOffset: payload.payloadOffset,
      embeddedPayloadBytes: payload.payloadBytes,
      embeddedNupkgName: nupkg.name,
      embeddedNupkgBytes: nupkg.uncompressedBytes,
      embeddedNupkgSha256: nupkg.sha256,
      embeddedNupkgSha1: nupkg.sha1,
      releases,
      externalReleasesMatched: true,
      entries: Object.freeze(inspected.map((entry) => Object.freeze({
        name: entry.name,
        compressedBytes: entry.compressedBytes,
        uncompressedBytes: entry.uncompressedBytes,
        sha256: entry.sha256,
      }))),
    });
  } finally {
    closeSync(descriptor);
  }
}

export async function verifySquirrelNupkgApplicationPayload(input: {
  nupkgPath: string;
  expectedApplicationBytes: number;
  expectedApplicationSha256: string;
  expectedManifestBytes: number;
  expectedManifestSha256: string;
}): Promise<SquirrelNupkgApplicationEvidence> {
  const applicationPath = "lib/net45/RangaBot.exe" as const;
  const manifestPath = "lib/net45/resources/rangabot-resources/desktop/manifest.json" as const;
  if (!Number.isSafeInteger(input.expectedApplicationBytes) || input.expectedApplicationBytes <= 0
    || !Number.isSafeInteger(input.expectedManifestBytes) || input.expectedManifestBytes <= 0
    || input.expectedManifestBytes > MAXIMUM_DESKTOP_MANIFEST_BYTES
    || !/^[0-9a-f]{64}$/u.test(input.expectedApplicationSha256)
    || !/^[0-9a-f]{64}$/u.test(input.expectedManifestSha256)) {
    throw new Error("The expected Squirrel NUPKG application evidence is invalid.");
  }
  const nupkgPath = resolve(input.nupkgPath);
  const before = lstatSync(nupkgPath, { bigint: true });
  requireStableRegularFile(nupkgPath, before, "Squirrel full NUPKG");
  const identity = fileIdentity(before);
  const descriptor = openSync(nupkgPath, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(identity, fileIdentity(opened))) throw new Error("Squirrel full NUPKG changed while it was opened.");
    const size = Number(opened.size);
    const reader = descriptorReader(descriptor, size, "Squirrel full NUPKG");
    const payload: SquirrelPayloadResourceEvidence = Object.freeze({
      format: "PE32",
      machine: "i386",
      largeAddressAware: true,
      resourceType: "DATA",
      resourceNameId: 131,
      resourceLanguageId: 1033,
      payloadOffset: 0,
      payloadBytes: size,
    });
    const end = findEndOfCentralDirectory(reader, payload, "Squirrel full NUPKG", SQUIRREL_NUPKG_ZIP_POLICY);
    const entries = readZipCentralEntries(reader, payload, "Squirrel full NUPKG", SQUIRREL_NUPKG_ZIP_POLICY);
    if (new Set(entries.map((entry) => entry.name.toLowerCase())).size !== entries.length) {
      throw new Error("Squirrel full NUPKG has case-insensitive path collisions.");
    }
    const application = entries.find((entry) => entry.name === applicationPath && !entry.directory);
    const manifest = entries.find((entry) => entry.name === manifestPath && !entry.directory);
    if (!application || !manifest) {
      throw new Error("Squirrel full NUPKG is missing the exact packaged application identity files.");
    }
    const layoutEntries = [...entries].sort((left, right) => left.localHeaderOffset - right.localHeaderOffset);
    if (layoutEntries[0]?.localHeaderOffset !== 0
      || new Set(layoutEntries.map((entry) => entry.localHeaderOffset)).size !== layoutEntries.length) {
      throw new Error("Squirrel full NUPKG has an invalid local ZIP layout.");
    }
    const inspectTarget = async (entry: ZipCentralEntry, capture: boolean, maximumCaptureBytes: number) => {
      const index = layoutEntries.indexOf(entry);
      const expectedEndOffset = layoutEntries[index + 1]?.localHeaderOffset ?? end.centralOffset;
      if (index < 0 || expectedEndOffset <= entry.localHeaderOffset) {
        throw new Error("Squirrel full NUPKG has overlapping local ZIP entries.");
      }
      return inspectZipEntry({
        descriptor,
        setupPath: nupkgPath,
        reader,
        payload,
        centralOffset: end.centralOffset,
        expectedEndOffset,
        entry,
        capture,
        maximumCaptureBytes,
        allowPaths: true,
        label: `Squirrel full NUPKG entry ${entry.name}`,
      });
    };
    const applicationEvidence = await inspectTarget(application, false, 0);
    const manifestEvidence = await inspectTarget(manifest, true, MAXIMUM_DESKTOP_MANIFEST_BYTES);
    if (applicationEvidence.uncompressedBytes !== input.expectedApplicationBytes
      || applicationEvidence.sha256 !== input.expectedApplicationSha256) {
      throw new Error("Squirrel full NUPKG does not contain the exact packaged RangaBot.exe.");
    }
    if (manifestEvidence.uncompressedBytes !== input.expectedManifestBytes
      || manifestEvidence.sha256 !== input.expectedManifestSha256) {
      throw new Error("Squirrel full NUPKG does not contain the exact desktop artifact manifest.");
    }
    const afterRead = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(nupkgPath, { bigint: true });
    if (!sameIdentity(identity, fileIdentity(afterRead)) || !sameIdentity(identity, fileIdentity(afterPath))) {
      throw new Error("Squirrel full NUPKG changed while its application payload was inspected.");
    }
    return Object.freeze({
      nupkgBytes: size,
      applicationPath,
      applicationBytes: applicationEvidence.uncompressedBytes,
      applicationSha256: applicationEvidence.sha256,
      manifestPath,
      manifestBytes: manifestEvidence.uncompressedBytes,
      manifestSha256: manifestEvidence.sha256,
    });
  } finally {
    closeSync(descriptor);
  }
}
