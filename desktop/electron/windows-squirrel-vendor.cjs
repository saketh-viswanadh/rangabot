const { createHash } = require("node:crypto");
const {
  closeSync,
  constants,
  cpSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} = require("node:fs");
const { dirname, resolve } = require("node:path");

const ELECTRON_WINSTALLER_VERSION = "5.4.4";
const ELECTRON_WINSTALLER_LOCK_INTEGRITY = "sha512-j9ETcBGJaXxAY/b6UBpR7LZfjdU4BAO+yvr4ifqHEdyuc3UNCy91PDGkWKY5UQ4coHNYfnwFggrqD6QPeFGAlg==";
const SQUIRREL_WINDOWS_TAG = "2.0.1";
const SQUIRREL_WINDOWS_SOURCE_COMMIT = "eef37460aef77b2f9de8cd2237c1e55b344a6554";
const ORIGINAL_VENDOR_INVENTORY_SHA256 = "dfbbefe42629ae1ebac89cc31dcf5f721cc0e96a4df020b519598695daa347ca";
const PREPARED_VENDOR_INVENTORY_SHA256 = "73b9079b4c4edaa64689d5ae261e890e9f738cbd3dda77ddf13ece9d3391bf95";
const ORIGINAL_VENDOR_INVENTORY_SCOPE = "package-owned files excluding install-generated 7z aliases";
const X86_MACHINE = 0x014c;
const IMAGE_FILE_EXECUTABLE_IMAGE = 0x0002;
const IMAGE_FILE_32BIT_MACHINE = 0x0100;
const IMAGE_FILE_LARGE_ADDRESS_AWARE = 0x0020;
const EXPECTED_ORIGINAL_CHARACTERISTICS = IMAGE_FILE_EXECUTABLE_IMAGE | IMAGE_FILE_32BIT_MACHINE;
const EXPECTED_PATCHED_CHARACTERISTICS = EXPECTED_ORIGINAL_CHARACTERISTICS | IMAGE_FILE_LARGE_ADDRESS_AWARE;
const MAXIMUM_PE_HEADER_OFFSET = 16 * 1024 * 1024;
const VENDOR_MANIFEST_NAME = "RANGABOT-SQUIRREL-VENDOR.json";
const WINSTALLER_LICENSE_NAME = "ELECTRON-WINSTALLER-LICENSE.txt";
const INSTALL_GENERATED_VENDOR_FILES = new Set(["7z.dll", "7z.exe"]);
const TARGET_SEVEN_ZIP_ALIASES = Object.freeze([
  Object.freeze({ name: "7z.dll", source: "7z-x64.dll" }),
  Object.freeze({ name: "7z.exe", source: "7z-x64.exe" }),
]);

const PATCHED_BINARIES = Object.freeze([
  Object.freeze({
    name: "WriteZipToSetup.exe",
    bytes: 112128,
    originalSha256: "9278fe28ac434fde0be3a10788dc13ad92a28940ed70a52f86d9d69435599349",
    patchedSha256: "7a6442efd88adb0b5dd0e17d4aa9ee83b791d98048d5fec2244ff7c377264713",
  }),
  Object.freeze({
    name: "Setup.exe",
    bytes: 223232,
    originalSha256: "1e47eb606dad4c5c1568cfb8f4e970e1051ba5806aedb1ff3256284a8280d83b",
    patchedSha256: "f5f59f056729582920b43e6aaed2507bb80f3ed48cac045814a74af816068a5b",
  }),
]);

const LOCKED_VENDOR_FILES = Object.freeze([
  ...PATCHED_BINARIES.map((entry) => Object.freeze({ name: entry.name, sha256: entry.patchedSha256 })),
  Object.freeze({
    name: "Squirrel.exe",
    sha256: "76359cd4b0349a83337b941332ad042c90351c2bb0a4628307740324c97984cc",
  }),
  Object.freeze({
    name: WINSTALLER_LICENSE_NAME,
    sha256: "379ecb81d11a2c2a72225e0cf8cd04803b220da64e1668042ddd0d04bd1c8666",
  }),
]);

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

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

function requireStableRegularFile(path, status, label) {
  if (status.isSymbolicLink() || !status.isFile() || status.nlink !== BigInt(1)
    || status.size <= BigInt(0) || status.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} must be one stable, non-linked regular file.`);
  }
  const canonical = realpathSync(path);
  const matches = process.platform === "win32"
    ? canonical.toLowerCase() === path.toLowerCase()
    : canonical === path;
  if (!matches) throw new Error(`${label} must resolve to its exact requested path.`);
}

function readStableRegularFile(pathInput, label) {
  const path = resolve(pathInput);
  const before = lstatSync(path, { bigint: true });
  requireStableRegularFile(path, before, label);
  const identity = fileIdentity(before);
  const descriptor = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(identity, fileIdentity(opened))) throw new Error(`${label} changed while it was opened.`);
    const bytes = Number(opened.size);
    const buffer = Buffer.alloc(bytes);
    let offset = 0;
    while (offset < bytes) {
      const count = readSync(descriptor, buffer, offset, bytes - offset, offset);
      if (count === 0) throw new Error(`${label} was truncated while it was read.`);
      offset += count;
    }
    const afterRead = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(identity, fileIdentity(afterRead))) throw new Error(`${label} changed while it was read.`);
    const afterPath = lstatSync(path, { bigint: true });
    if (!sameIdentity(identity, fileIdentity(afterPath))) throw new Error(`${label} changed while it was read.`);
    return buffer;
  } finally {
    closeSync(descriptor);
  }
}

function inspectPe32X86CharacteristicsBuffer(source, label = "Squirrel executable") {
  if (!Buffer.isBuffer(source) || source.length < 64 || source.readUInt16LE(0) !== 0x5a4d) {
    throw new Error(`${label} is not a complete MZ executable.`);
  }
  const peOffset = source.readUInt32LE(0x3c);
  if (peOffset < 64 || peOffset > MAXIMUM_PE_HEADER_OFFSET || peOffset > source.length - 24) {
    throw new Error(`${label} has an out-of-bounds PE header.`);
  }
  if (source.readUInt32LE(peOffset) !== 0x00004550) throw new Error(`${label} is missing the PE signature.`);
  const machine = source.readUInt16LE(peOffset + 4);
  if (machine !== X86_MACHINE) throw new Error(`${label} is not the expected PE32/i386 binary.`);
  const optionalHeaderBytes = source.readUInt16LE(peOffset + 20);
  const optionalHeaderOffset = peOffset + 24;
  if (optionalHeaderBytes < 96 || optionalHeaderOffset + optionalHeaderBytes > source.length
    || source.readUInt16LE(optionalHeaderOffset) !== 0x10b) {
    throw new Error(`${label} is not a complete PE32 image.`);
  }
  const characteristicsOffset = peOffset + 22;
  return Object.freeze({
    machine,
    characteristicsOffset,
    characteristics: source.readUInt16LE(characteristicsOffset),
  });
}

function patchLargeAddressAwareBuffer(sourceInput, policy) {
  const source = Buffer.from(sourceInput);
  if (source.length !== policy.bytes || sha256(source) !== policy.originalSha256) {
    throw new Error(`${policy.name} does not match the locked electron-winstaller input.`);
  }
  const before = inspectPe32X86CharacteristicsBuffer(source, policy.name);
  if (before.characteristics !== EXPECTED_ORIGINAL_CHARACTERISTICS) {
    throw new Error(`${policy.name} does not have the locked non-LAA characteristics.`);
  }
  source.writeUInt16LE(EXPECTED_PATCHED_CHARACTERISTICS, before.characteristicsOffset);
  const after = inspectPe32X86CharacteristicsBuffer(source, policy.name);
  if (after.characteristics !== EXPECTED_PATCHED_CHARACTERISTICS || sha256(source) !== policy.patchedSha256) {
    throw new Error(`${policy.name} did not produce the locked one-bit LAA mutation.`);
  }
  let differences = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== sourceInput[index]) differences += 1;
  }
  if (differences !== 1) throw new Error(`${policy.name} changed outside the single expected COFF byte.`);
  return source;
}

function writeStableGeneratedFile(pathInput, source, mode = 0o755) {
  const path = resolve(pathInput);
  const temporary = `${path}.rangabot-${process.pid}`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, source, { flag: "wx", mode });
  const descriptor = openSync(temporary, constants.O_RDWR | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const status = fstatSync(descriptor, { bigint: true });
    requireStableRegularFile(temporary, status, `Generated ${path}`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  rmSync(path, { force: true });
  renameSync(temporary, path);
}

function requireRealDirectory(pathInput, label) {
  const path = resolve(pathInput);
  const status = lstatSync(path);
  const canonical = realpathSync(path);
  const matches = process.platform === "win32"
    ? canonical.toLowerCase() === path.toLowerCase()
    : canonical === path;
  if (status.isSymbolicLink() || !status.isDirectory() || !matches) {
    throw new Error(`${label} must be one real local directory.`);
  }
  return path;
}

function assertRealDirectoryTree(directoryInput, label) {
  const directory = requireRealDirectory(directoryInput, label);
  for (const name of readdirSync(directory)) {
    const path = resolve(directory, name);
    const status = lstatSync(path);
    if (status.isSymbolicLink()) throw new Error(`${label} contains a symbolic link.`);
    if (status.isDirectory()) assertRealDirectoryTree(path, label);
    else if (!status.isFile()) throw new Error(`${label} contains an unsupported filesystem entry.`);
  }
  return directory;
}

function collectVendorFiles(directoryInput, prefix = "") {
  const directory = requireRealDirectory(directoryInput, "Prepared Squirrel vendor directory");
  const files = [];
  for (const name of readdirSync(directory).sort()) {
    if (!prefix && name === VENDOR_MANIFEST_NAME) continue;
    const path = resolve(directory, name);
    const relativePath = prefix ? `${prefix}/${name}` : name;
    const status = lstatSync(path, { bigint: true });
    if (status.isSymbolicLink()) throw new Error("Prepared Squirrel vendor contains a symbolic link.");
    if (status.isDirectory()) files.push(...collectVendorFiles(path, relativePath));
    else if (status.isFile()) {
      const source = readStableRegularFile(path, `Prepared Squirrel vendor ${relativePath}`);
      files.push(Object.freeze({ path: relativePath, bytes: source.length, sha256: sha256(source) }));
    } else throw new Error("Prepared Squirrel vendor contains an unsupported filesystem entry.");
  }
  return files;
}

function inventorySha256(files) {
  return sha256(Buffer.from(JSON.stringify(files)));
}

function preparePatchedSquirrelVendor(input) {
  const packageRoot = requireRealDirectory(input.electronWinstallerRoot, "electron-winstaller package root");
  const sourceDirectory = assertRealDirectoryTree(resolve(packageRoot, "vendor"), "electron-winstaller vendor directory");
  const packageRecord = JSON.parse(readStableRegularFile(resolve(packageRoot, "package.json"), "electron-winstaller package metadata").toString("utf8"));
  if (packageRecord.name !== "electron-winstaller" || packageRecord.version !== ELECTRON_WINSTALLER_VERSION) {
    throw new Error("The staged Squirrel vendor is not from the locked electron-winstaller version.");
  }
  const packageLock = JSON.parse(readStableRegularFile(
    resolve(packageRoot, "..", "..", "package-lock.json"),
    "RangaBot package lock",
  ).toString("utf8"));
  const lockedPackage = packageLock?.packages?.["node_modules/electron-winstaller"];
  if (lockedPackage?.version !== ELECTRON_WINSTALLER_VERSION
    || lockedPackage?.integrity !== ELECTRON_WINSTALLER_LOCK_INTEGRITY) {
    throw new Error("The staged Squirrel vendor is not bound to the locked electron-winstaller package integrity.");
  }
  const originalVendorFiles = Object.freeze(
    collectVendorFiles(sourceDirectory).filter((entry) => !INSTALL_GENERATED_VENDOR_FILES.has(entry.path)),
  );
  if (inventorySha256(originalVendorFiles) !== ORIGINAL_VENDOR_INVENTORY_SHA256) {
    throw new Error("The electron-winstaller vendor tree does not match the locked package-owned inventory.");
  }
  const destinationDirectory = resolve(input.destinationDirectory);
  rmSync(destinationDirectory, { recursive: true, force: true });
  mkdirSync(dirname(destinationDirectory), { recursive: true, mode: 0o755 });
  cpSync(sourceDirectory, destinationDirectory, { recursive: true, dereference: true, preserveTimestamps: false });
  cpSync(resolve(packageRoot, "LICENSE"), resolve(destinationDirectory, WINSTALLER_LICENSE_NAME), {
    dereference: true,
    preserveTimestamps: false,
  });
  for (const alias of TARGET_SEVEN_ZIP_ALIASES) {
    const source = readStableRegularFile(
      resolve(sourceDirectory, alias.source),
      `Locked Squirrel vendor ${alias.source}`,
    );
    writeStableGeneratedFile(resolve(destinationDirectory, alias.name), source);
  }
  for (const policy of PATCHED_BINARIES) {
    const sourcePath = resolve(sourceDirectory, policy.name);
    const source = readStableRegularFile(sourcePath, `Locked ${policy.name}`);
    const patched = patchLargeAddressAwareBuffer(source, policy);
    writeStableGeneratedFile(resolve(destinationDirectory, policy.name), patched);
  }
  const manifest = Object.freeze({
    schemaVersion: 1,
    electronWinstallerVersion: ELECTRON_WINSTALLER_VERSION,
    electronWinstallerIntegrity: ELECTRON_WINSTALLER_LOCK_INTEGRITY,
    squirrelWindowsTag: SQUIRREL_WINDOWS_TAG,
    squirrelWindowsSourceCommit: SQUIRREL_WINDOWS_SOURCE_COMMIT,
    mutation: "COFF IMAGE_FILE_LARGE_ADDRESS_AWARE bit only",
    originalVendorInventoryScope: ORIGINAL_VENDOR_INVENTORY_SCOPE,
    originalVendorInventorySha256: ORIGINAL_VENDOR_INVENTORY_SHA256,
    preparedVendorInventorySha256: PREPARED_VENDOR_INVENTORY_SHA256,
    normalizedSevenZipAliases: TARGET_SEVEN_ZIP_ALIASES,
    mutations: PATCHED_BINARIES.map((entry) => Object.freeze({ ...entry })),
    vendorFiles: Object.freeze(collectVendorFiles(destinationDirectory)),
  });
  if (inventorySha256(manifest.vendorFiles) !== PREPARED_VENDOR_INVENTORY_SHA256) {
    throw new Error("The prepared Squirrel vendor tree does not match the locked complete inventory.");
  }
  writeStableGeneratedFile(
    resolve(destinationDirectory, VENDOR_MANIFEST_NAME),
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    0o644,
  );
  assertPreparedSquirrelVendor(destinationDirectory);
  return Object.freeze({ destinationDirectory, manifest });
}

function assertPreparedSquirrelVendor(directoryInput) {
  const directory = requireRealDirectory(directoryInput, "Prepared Squirrel vendor directory");
  for (const file of LOCKED_VENDOR_FILES) {
    const source = readStableRegularFile(resolve(directory, file.name), `Prepared Squirrel vendor ${file.name}`);
    if (sha256(source) !== file.sha256) throw new Error(`Prepared Squirrel vendor ${file.name} has an unexpected digest.`);
  }
  for (const policy of PATCHED_BINARIES) {
    const source = readStableRegularFile(resolve(directory, policy.name), `Prepared Squirrel vendor ${policy.name}`);
    const inspected = inspectPe32X86CharacteristicsBuffer(source, policy.name);
    if (inspected.characteristics !== EXPECTED_PATCHED_CHARACTERISTICS) {
      throw new Error(`Prepared Squirrel vendor ${policy.name} is not large-address-aware.`);
    }
  }
  const manifest = JSON.parse(readStableRegularFile(
    resolve(directory, VENDOR_MANIFEST_NAME),
    "Prepared Squirrel vendor manifest",
  ).toString("utf8"));
  const vendorFiles = collectVendorFiles(directory);
  if (manifest.schemaVersion !== 1 || manifest.electronWinstallerVersion !== ELECTRON_WINSTALLER_VERSION
    || manifest.electronWinstallerIntegrity !== ELECTRON_WINSTALLER_LOCK_INTEGRITY
    || manifest.squirrelWindowsTag !== SQUIRREL_WINDOWS_TAG
    || manifest.squirrelWindowsSourceCommit !== SQUIRREL_WINDOWS_SOURCE_COMMIT
    || manifest.mutation !== "COFF IMAGE_FILE_LARGE_ADDRESS_AWARE bit only"
    || manifest.originalVendorInventoryScope !== ORIGINAL_VENDOR_INVENTORY_SCOPE
    || manifest.originalVendorInventorySha256 !== ORIGINAL_VENDOR_INVENTORY_SHA256
    || manifest.preparedVendorInventorySha256 !== PREPARED_VENDOR_INVENTORY_SHA256
    || JSON.stringify(manifest.normalizedSevenZipAliases) !== JSON.stringify(TARGET_SEVEN_ZIP_ALIASES)
    || JSON.stringify(manifest.mutations) !== JSON.stringify(PATCHED_BINARIES)
    || !Array.isArray(manifest.vendorFiles)
    || inventorySha256(vendorFiles) !== PREPARED_VENDOR_INVENTORY_SHA256
    || JSON.stringify(manifest.vendorFiles) !== JSON.stringify(vendorFiles)) {
    throw new Error("Prepared Squirrel vendor manifest is invalid.");
  }
  return Object.freeze({ directory, manifest });
}

module.exports = {
  ELECTRON_WINSTALLER_VERSION,
  EXPECTED_ORIGINAL_CHARACTERISTICS,
  EXPECTED_PATCHED_CHARACTERISTICS,
  PATCHED_BINARIES,
  SQUIRREL_WINDOWS_SOURCE_COMMIT,
  SQUIRREL_WINDOWS_TAG,
  VENDOR_MANIFEST_NAME,
  assertPreparedSquirrelVendor,
  inspectPe32X86CharacteristicsBuffer,
  patchLargeAddressAwareBuffer,
  preparePatchedSquirrelVendor,
};
