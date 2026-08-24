import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

type FileIdentity = Readonly<{
  device: bigint;
  inode: bigint;
  links: bigint;
  size: bigint;
  modified: bigint;
  changed: bigint;
}>;

type DirectoryIdentity = Readonly<{
  device: bigint;
  inode: bigint;
}>;

function errorCode(error: unknown) {
  return (error as NodeJS.ErrnoException).code;
}

function comparablePath(path: string) {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

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

function sameFileIdentity(left: FileIdentity, right: FileIdentity) {
  return left.device === right.device
    && left.inode === right.inode
    && left.links === right.links
    && left.size === right.size
    && left.modified === right.modified
    && left.changed === right.changed;
}

function sameFileEntry(left: FileIdentity, right: FileIdentity) {
  return left.device === right.device && left.inode === right.inode;
}

function inspectDirectory(path: string, label: string): DirectoryIdentity {
  const status = lstatSync(path, { bigint: true });
  if (status.isSymbolicLink() || !status.isDirectory() || status.nlink < BigInt(1)
    || comparablePath(realpathSync(path)) !== comparablePath(path)) {
    throw new Error(`${label} directory must be one real, non-linked directory.`);
  }
  return Object.freeze({ device: status.dev, inode: status.ino });
}

function requireSameDirectory(path: string, expected: DirectoryIdentity, label: string) {
  const current = inspectDirectory(path, label);
  if (current.device !== expected.device || current.inode !== expected.inode) {
    throw new Error(`${label} directory changed while evidence was written.`);
  }
}

function inspectRegularFile(path: string, label: string): FileIdentity {
  const status = lstatSync(path, { bigint: true });
  if (status.isSymbolicLink() || !status.isFile() || status.nlink !== BigInt(1)
    || comparablePath(realpathSync(path)) !== comparablePath(path)) {
    throw new Error(`${label} must be one real, non-linked regular file.`);
  }
  return fileIdentity(status);
}

function inspectOptionalDestination(path: string, label: string): FileIdentity | null {
  try {
    return inspectRegularFile(path, label);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function removePublishedEntryIfOwned(path: string, identity: FileIdentity) {
  try {
    const current = lstatSync(path, { bigint: true });
    if (!current.isSymbolicLink() && current.isFile()
      && sameFileEntry(identity, fileIdentity(current))) {
      unlinkSync(path);
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function synchronizeDirectory(path: string, expected: DirectoryIdentity, label: string) {
  requireSameDirectory(path, expected, label);
  if (process.platform === "win32") return;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isDirectory() || opened.dev !== expected.device || opened.ino !== expected.inode) {
      throw new Error(`${label} directory changed before its metadata was synchronized.`);
    }
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  requireSameDirectory(path, expected, label);
}

export function writeSafeAtomicJsonEvidence(pathInput: string, value: unknown, label = "Evidence output") {
  const path = resolve(pathInput);
  const directory = dirname(path);
  const directoryIdentity = inspectDirectory(directory, label);
  const existingIdentity = inspectOptionalDestination(path, label);
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) throw new Error(`${label} could not be serialized as JSON.`);
  const content = `${serialized}\n`;
  const contentBytes = Buffer.from(content, "utf8");
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  let temporaryIdentity: FileIdentity | undefined;
  let renamed = false;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
      0o600,
    );
    if (process.platform !== "win32") fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, contentBytes);
    fsyncSync(descriptor);
    const written = fstatSync(descriptor, { bigint: true });
    if (!written.isFile() || written.nlink !== BigInt(1) || written.size !== BigInt(contentBytes.length)) {
      throw new Error(`${label} temporary file is unsafe or incomplete.`);
    }
    temporaryIdentity = fileIdentity(written);
    closeSync(descriptor);
    descriptor = undefined;

    const closedTemporaryIdentity = inspectRegularFile(temporary, `${label} temporary file`);
    if (!sameFileIdentity(temporaryIdentity, closedTemporaryIdentity)) {
      throw new Error(`${label} temporary file changed before publication.`);
    }
    requireSameDirectory(directory, directoryIdentity, label);

    const currentDestination = inspectOptionalDestination(path, label);
    if (existingIdentity === null) {
      if (currentDestination !== null) throw new Error(`${label} appeared while evidence was written.`);
    } else {
      if (currentDestination === null || !sameFileIdentity(existingIdentity, currentDestination)) {
        throw new Error(`${label} changed while evidence was written.`);
      }
    }

    renameSync(temporary, path);
    renamed = true;
    const published = inspectRegularFile(path, label);
    if (!sameFileEntry(temporaryIdentity, published)
      || published.links !== BigInt(1) || published.size !== BigInt(contentBytes.length)) {
      throw new Error(`${label} changed during atomic publication.`);
    }
    let publishedContent: Buffer;
    descriptor = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    try {
      const opened = fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || !sameFileIdentity(published, fileIdentity(opened))) {
        throw new Error(`${label} changed when its published file was opened.`);
      }
      publishedContent = readFileSync(descriptor);
      const afterRead = fstatSync(descriptor, { bigint: true });
      if (!sameFileIdentity(published, fileIdentity(afterRead))) {
        throw new Error(`${label} changed while its published content was verified.`);
      }
    } finally {
      closeSync(descriptor);
      descriptor = undefined;
    }
    if (!publishedContent.equals(contentBytes)) throw new Error(`${label} content changed after publication.`);
    const finalIdentity = inspectRegularFile(path, label);
    if (!sameFileIdentity(published, finalIdentity)) throw new Error(`${label} changed after publication.`);
    synchronizeDirectory(directory, directoryIdentity, label);
    const durableIdentity = inspectRegularFile(path, label);
    if (!sameFileIdentity(published, durableIdentity)) throw new Error(`${label} changed while publication was synchronized.`);
    return Object.freeze({ path, bytes: contentBytes.length });
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* Preserve the original failure. */ }
    }
    if (renamed && temporaryIdentity) {
      try { removePublishedEntryIfOwned(path, temporaryIdentity); } catch { /* Preserve the original failure. */ }
    } else {
      try { unlinkSync(temporary); } catch { /* The exclusive sibling may not exist. */ }
    }
    throw error;
  }
}
