import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { resolve } from "node:path";

const windowsReservedName = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu;
const windowsInvalidCharacter = /[<>:"|?*\u0000-\u001f]/u;

export type StableFileIdentity = Readonly<{
  device: bigint;
  inode: bigint;
  links: bigint;
  size: bigint;
  modified: bigint;
  changed: bigint;
}>;

export type StableFileEvidence = Readonly<{
  path: string;
  bytes: number;
  sha256: string;
  identity: StableFileIdentity;
  singleLinkRequired: boolean;
  content?: Buffer;
}>;

function identity(status: BigIntStats): StableFileIdentity {
  return Object.freeze({
    device: status.dev,
    inode: status.ino,
    links: status.nlink,
    size: status.size,
    modified: status.mtimeNs,
    changed: status.ctimeNs,
  });
}

function sameIdentity(left: StableFileIdentity, right: StableFileIdentity) {
  return left.device === right.device && left.inode === right.inode
    && left.links === right.links && left.size === right.size
    && left.modified === right.modified && left.changed === right.changed;
}

function comparablePath(path: string) {
  return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
}

function requireStableFile(path: string, status: BigIntStats, label: string, allowEmpty: boolean, requireSingleLink: boolean) {
  if (status.isSymbolicLink() || !status.isFile() || (requireSingleLink && status.nlink !== BigInt(1))
    || (!allowEmpty && status.size <= BigInt(0))
    || status.size > BigInt(Number.MAX_SAFE_INTEGER)
    || comparablePath(realpathSync(path)) !== comparablePath(path)) {
    throw new Error(`${label} must be one real, non-linked, single-link regular file.`);
  }
}

export function inspectStableFile(pathInput: string, input: Readonly<{
  label: string;
  allowEmpty?: boolean;
  maximumBytes?: number;
  captureContent?: boolean;
  requireSingleLink?: boolean;
}>): StableFileEvidence {
  const path = resolve(pathInput);
  const before = lstatSync(path, { bigint: true });
  const singleLinkRequired = input.requireSingleLink !== false;
  requireStableFile(path, before, input.label, input.allowEmpty === true, singleLinkRequired);
  if (input.maximumBytes !== undefined && before.size > BigInt(input.maximumBytes)) {
    throw new Error(`${input.label} exceeds its permitted size.`);
  }
  const expected = identity(before);
  const descriptor = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  const hash = createHash("sha256");
  const captured: Buffer[] = [];
  let bytes = 0;
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    requireStableFile(path, opened, input.label, input.allowEmpty === true, singleLinkRequired);
    if (!sameIdentity(expected, identity(opened))) throw new Error(`${input.label} changed while it was opened.`);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      const chunk = buffer.subarray(0, count);
      bytes += count;
      hash.update(chunk);
      if (input.captureContent) captured.push(Buffer.from(chunk));
    }
    const afterRead = fstatSync(descriptor, { bigint: true });
    if (bytes !== Number(before.size) || !sameIdentity(expected, identity(afterRead))) {
      throw new Error(`${input.label} changed while it was read.`);
    }
  } finally {
    closeSync(descriptor);
  }
  const after = lstatSync(path, { bigint: true });
  requireStableFile(path, after, input.label, input.allowEmpty === true, singleLinkRequired);
  if (!sameIdentity(expected, identity(after))) throw new Error(`${input.label} changed while it was inspected.`);
  return Object.freeze({
    path,
    bytes,
    sha256: hash.digest("hex"),
    identity: expected,
    singleLinkRequired,
    ...(input.captureContent ? { content: Buffer.concat(captured) } : {}),
  });
}

export function assertStableFileUnchanged(evidence: StableFileEvidence, label: string) {
  const current = lstatSync(evidence.path, { bigint: true });
  requireStableFile(evidence.path, current, label, evidence.bytes === 0, evidence.singleLinkRequired);
  if (!sameIdentity(evidence.identity, identity(current))) throw new Error(`${label} changed after inspection.`);
}

export function assertOpenDescriptorMatchesStableFile(
  descriptor: number,
  evidence: StableFileEvidence,
  label: string,
) {
  const opened = fstatSync(descriptor, { bigint: true });
  requireStableFile(evidence.path, opened, label, evidence.bytes === 0, evidence.singleLinkRequired);
  if (!sameIdentity(evidence.identity, identity(opened))) {
    throw new Error(`${label} opened descriptor does not match the pre-hashed file identity.`);
  }
}

/**
 * Return one canonical package path or reject every spelling Windows could
 * reinterpret (drive/UNC paths, traversal, ADS, device names, or aliases).
 */
export function validateWindowsPackagePath(pathInput: string, label = "Package path") {
  if (typeof pathInput !== "string" || !pathInput || /[\r\n]/u.test(pathInput)
    || /^[\\/]/u.test(pathInput) || /^[A-Za-z]:/u.test(pathInput)) {
    throw new Error(`${label} is not a safe relative Windows path.`);
  }
  const canonical = pathInput.replaceAll("\\", "/");
  const components = canonical.split("/");
  if (components.some((component) => !component || component === "." || component === "..")) {
    throw new Error(`${label} contains an empty or traversal component.`);
  }
  for (const component of components) {
    if (component.endsWith(".") || component.endsWith(" ") || windowsInvalidCharacter.test(component)
      || windowsReservedName.test(component) || Buffer.byteLength(component, "utf8") > 255) {
      throw new Error(`${label} contains a Windows-unsafe component.`);
    }
  }
  if (canonical.length > 260) throw new Error(`${label} exceeds the APPX 260-character limit.`);
  return canonical;
}

export function windowsPackagePathKey(pathInput: string, label = "Package path") {
  return validateWindowsPackagePath(pathInput, label).normalize("NFC").toLocaleLowerCase("en-US");
}

export function assertUniqueWindowsPackagePaths(paths: readonly string[], label = "Package inventory") {
  const seen = new Map<string, string>();
  for (const path of paths) {
    const key = windowsPackagePathKey(path, `${label} entry`);
    const previous = seen.get(key);
    if (previous !== undefined) {
      throw new Error(`${label} contains a Windows path collision: ${previous} and ${path}.`);
    }
    seen.set(key, path);
  }
}
