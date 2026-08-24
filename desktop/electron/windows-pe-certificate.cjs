const {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} = require("node:fs");
const { resolve } = require("node:path");

const DOS_HEADER_BYTES = 64;
const PE_SIGNATURE_AND_COFF_BYTES = 24;
const PE32_MAGIC = 0x10b;
const PE32_PLUS_MAGIC = 0x20b;
const X86_MACHINE = 0x014c;
const X64_MACHINE = 0x8664;
const CERTIFICATE_DIRECTORY_INDEX = 4;
const MAXIMUM_PE_HEADER_OFFSET = 16 * 1024 * 1024;

function fileIdentity(status) {
  return Object.freeze({
    device: status.dev,
    inode: status.ino,
    links: status.nlink,
    size: status.size,
    modified: status.mtimeNs,
    changed: status.ctimeNs,
  });
}

function sameIdentity(left, right) {
  return left.device === right.device && left.inode === right.inode
    && left.links === right.links && left.size === right.size
    && left.modified === right.modified && left.changed === right.changed;
}

function readExactly(descriptor, length, position, label) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const bytesRead = readSync(descriptor, buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) throw new Error(`${label} is truncated.`);
    offset += bytesRead;
  }
  return buffer;
}

function inspectWindowsPeCertificateTableBuffer(source, label = "Windows executable", fileBytes = source.length) {
  if (!Buffer.isBuffer(source) || source.length < DOS_HEADER_BYTES) {
    throw new Error(`${label} is not a complete PE image.`);
  }
  if (source.readUInt16LE(0) !== 0x5a4d) throw new Error(`${label} is missing the MZ header.`);
  const peOffset = source.readUInt32LE(0x3c);
  if (peOffset < DOS_HEADER_BYTES || peOffset > source.length - PE_SIGNATURE_AND_COFF_BYTES) {
    throw new Error(`${label} has an out-of-bounds PE header.`);
  }
  if (source.readUInt32LE(peOffset) !== 0x00004550) throw new Error(`${label} is missing the PE signature.`);
  const machine = source.readUInt16LE(peOffset + 4);
  if (machine !== X86_MACHINE && machine !== X64_MACHINE) throw new Error(`${label} has an unsupported PE machine.`);
  const optionalHeaderBytes = source.readUInt16LE(peOffset + 20);
  const optionalHeaderOffset = peOffset + PE_SIGNATURE_AND_COFF_BYTES;
  const optionalHeaderEnd = optionalHeaderOffset + optionalHeaderBytes;
  if (optionalHeaderBytes === 0 || optionalHeaderEnd > source.length) {
    throw new Error(`${label} has an out-of-bounds optional header.`);
  }
  const magic = source.readUInt16LE(optionalHeaderOffset);
  const pe32Plus = magic === PE32_PLUS_MAGIC;
  if (!pe32Plus && magic !== PE32_MAGIC) throw new Error(`${label} has an unsupported PE optional-header format.`);
  if ((machine === X64_MACHINE) !== pe32Plus) throw new Error(`${label} has inconsistent PE machine and optional-header formats.`);
  const directoryCountOffset = pe32Plus ? 108 : 92;
  const directoryStartOffset = pe32Plus ? 112 : 96;
  if (optionalHeaderBytes < directoryCountOffset + 4) {
    throw new Error(`${label} does not contain a complete data-directory count.`);
  }
  const directoryCount = source.readUInt32LE(optionalHeaderOffset + directoryCountOffset);
  const maximumDirectoryCount = Math.floor((optionalHeaderBytes - directoryStartOffset) / 8);
  if (directoryCount > maximumDirectoryCount) {
    throw new Error(`${label} claims data directories outside its optional header.`);
  }
  if (directoryCount <= CERTIFICATE_DIRECTORY_INDEX) {
    return Object.freeze({
      format: pe32Plus ? "PE32+" : "PE32",
      machine,
      embeddedPeCertificateTable: "absent",
      certificateTableOffset: 0,
      certificateTableBytes: 0,
    });
  }
  const certificateEntryOffset = directoryStartOffset + CERTIFICATE_DIRECTORY_INDEX * 8;
  if (optionalHeaderBytes < certificateEntryOffset + 8) {
    throw new Error(`${label} claims a certificate directory outside its optional header.`);
  }
  const certificateTableOffset = source.readUInt32LE(optionalHeaderOffset + certificateEntryOffset);
  const certificateTableBytes = source.readUInt32LE(optionalHeaderOffset + certificateEntryOffset + 4);
  if (certificateTableOffset === 0 && certificateTableBytes === 0) {
    return Object.freeze({
      format: pe32Plus ? "PE32+" : "PE32",
      machine,
      embeddedPeCertificateTable: "absent",
      certificateTableOffset,
      certificateTableBytes,
    });
  }
  if (certificateTableOffset === 0 || certificateTableBytes === 0) {
    throw new Error(`${label} has an inconsistent embedded certificate-table entry.`);
  }
  if (certificateTableOffset % 8 !== 0 || certificateTableBytes < 8 || certificateTableBytes % 8 !== 0) {
    throw new Error(`${label} has a malformed embedded certificate table.`);
  }
  if (!Number.isSafeInteger(fileBytes) || fileBytes < source.length
    || certificateTableOffset < optionalHeaderEnd
    || certificateTableOffset > fileBytes - certificateTableBytes) {
    throw new Error(`${label} has an out-of-bounds embedded certificate table.`);
  }
  return Object.freeze({
    format: pe32Plus ? "PE32+" : "PE32",
    machine,
    embeddedPeCertificateTable: "present",
    certificateTableOffset,
    certificateTableBytes,
  });
}

function inspectWindowsPeCertificateTable(pathInput, label = "Windows executable") {
  const path = resolve(pathInput);
  const before = lstatSync(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== BigInt(1)
    || before.size < BigInt(DOS_HEADER_BYTES) || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} must be one stable, non-linked regular PE file.`);
  }
  const beforeIdentity = fileIdentity(before);
  const descriptor = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(beforeIdentity, fileIdentity(opened))) throw new Error(`${label} changed while it was opened.`);
    const dosHeader = readExactly(descriptor, DOS_HEADER_BYTES, 0, label);
    if (dosHeader.readUInt16LE(0) !== 0x5a4d) throw new Error(`${label} is missing the MZ header.`);
    const peOffset = dosHeader.readUInt32LE(0x3c);
    if (peOffset < DOS_HEADER_BYTES || peOffset > MAXIMUM_PE_HEADER_OFFSET
      || peOffset > Number(opened.size) - PE_SIGNATURE_AND_COFF_BYTES) {
      throw new Error(`${label} has an out-of-bounds PE header.`);
    }
    const peAndCoff = readExactly(descriptor, PE_SIGNATURE_AND_COFF_BYTES, peOffset, label);
    const optionalHeaderBytes = peAndCoff.readUInt16LE(20);
    const headerBytes = peOffset + PE_SIGNATURE_AND_COFF_BYTES + optionalHeaderBytes;
    if (optionalHeaderBytes === 0 || headerBytes > Number(opened.size)) {
      throw new Error(`${label} has an out-of-bounds optional header.`);
    }
    const source = readExactly(descriptor, headerBytes, 0, label);
    const result = inspectWindowsPeCertificateTableBuffer(source, label, Number(opened.size));
    const afterRead = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(beforeIdentity, fileIdentity(afterRead))) throw new Error(`${label} changed while it was inspected.`);
    const afterPath = lstatSync(path, { bigint: true });
    if (!sameIdentity(beforeIdentity, fileIdentity(afterPath))) throw new Error(`${label} changed while it was inspected.`);
    return result;
  } finally {
    closeSync(descriptor);
  }
}

function assertWindowsPeCertificateTableAbsent(path, label = "Windows executable") {
  const result = inspectWindowsPeCertificateTable(path, label);
  if (result.embeddedPeCertificateTable !== "absent") {
    throw new Error(`${label} contains an embedded PE certificate table; the unsigned candidate must not strip or conceal it.`);
  }
  return result;
}

module.exports = {
  assertWindowsPeCertificateTableAbsent,
  inspectWindowsPeCertificateTable,
  inspectWindowsPeCertificateTableBuffer,
};
