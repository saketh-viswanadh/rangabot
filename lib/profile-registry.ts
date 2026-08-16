import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { syncDirectoryMetadata } from "./directory-durability.ts";

export const PROFILE_REGISTRY_SCHEMA_VERSION = 1 as const;
export const PROFILE_REGISTRY_DIRECTORY_NAME = "profiles-v1";
export const PROFILE_DATA_DIRECTORY_NAME = "data";
export const DEFAULT_PROFILE_DISPLAY_NAME = "Default";
export const PROFILE_REGISTRY_MAX_PROFILES = 64;

const registryFileName = "registry.json";
const recoveryFileName = "registry.recovery.json";
const lockFileName = "registry.lock";
const maximumRegistryBytes = 128 * 1024;
const maximumLockBytes = 4 * 1024;
const lockAcquisitionAttempts = 8;
const lockClaimNamePattern = /^\.lock-claim-[0-9a-f]{48}\.tmp$/;
const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;
const posixGuards = process.platform !== "win32";
const localStartIdentity = randomUUID();

export type ProfileKind = "default" | "personal" | "testing";
export type CreatableProfileKind = Exclude<ProfileKind, "default">;

export type ProfileMetadata = Readonly<{
  id: string;
  displayName: string;
  kind: ProfileKind;
  protected: boolean;
  createdAt: string;
  updatedAt: string;
}>;

export type ProfileRegistrySnapshot = Readonly<{
  schemaVersion: typeof PROFILE_REGISTRY_SCHEMA_VERSION;
  generation: number;
  activeProfileId: string;
  createdAt: string;
  updatedAt: string;
  profiles: readonly ProfileMetadata[];
}>;

export type ProfileRegistryOwnerIdentity = Readonly<{
  pid: number;
  startIdentity: string;
}>;

export type ProfileRegistryOwnerState = "same-start" | "different-start" | "dead" | "unknown";

export type ProfileRegistryInspection =
  | Readonly<{ kind: "setup-required" }>
  | Readonly<{
    kind: "ready";
    snapshot: ProfileRegistrySnapshot;
    source: "primary" | "recovery";
  }>;

export type ProfileRegistryErrorCode =
  | "active-lock"
  | "already-initialized"
  | "conflict"
  | "duplicate-name"
  | "invalid"
  | "not-found"
  | "precondition"
  | "protected"
  | "setup-required"
  | "unsafe-storage";

export class ProfileRegistryError extends Error {
  readonly code: ProfileRegistryErrorCode;

  constructor(code: ProfileRegistryErrorCode, message: string) {
    super(message);
    this.name = "ProfileRegistryError";
    this.code = code;
  }
}

export type ProfileRegistryOptions = Readonly<{
  managedRoot: string;
  ownerIdentity?: ProfileRegistryOwnerIdentity;
  inspectOwner?: (owner: ProfileRegistryOwnerIdentity) => ProfileRegistryOwnerState;
  now?: () => Date;
  uuid?: () => string;
  lockToken?: () => string;
  /** @internal Deterministic race injection for registry lock protocol tests. */
  onLockClaimForTests?: (claim: Readonly<{
    lockFile: string;
    claimFile: string;
    expectedToken: string;
  }>) => void;
}>;

export type ProfileRegistryLayout = Readonly<{
  managedRoot: string;
  registryRoot: string;
  profilesRoot: string;
  registryFile: string;
  recoveryFile: string;
  lockFile: string;
}>;

type RegistryRead = Readonly<{
  snapshot: ProfileRegistrySnapshot;
  source: "primary" | "recovery";
}>;

type LockRecord = Readonly<{
  schemaVersion: 1;
  owner: ProfileRegistryOwnerIdentity;
  token: string;
  acquiredAt: string;
}>;

type FileRead =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "valid"; snapshot: ProfileRegistrySnapshot }>;

class InvalidRegistryFileError extends Error {}

function errorCode(error: unknown) {
  return (error as NodeJS.ErrnoException).code;
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function requireProfileId(value: unknown) {
  if (!isCanonicalUuid(value)) {
    throw new ProfileRegistryError("precondition", "Profile IDs must be canonical opaque UUIDs.");
  }
  return value;
}

function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function validOwnerIdentity(value: unknown): value is ProfileRegistryOwnerIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(",") === "pid,startIdentity"
    && Number.isSafeInteger(record.pid)
    && Number(record.pid) > 0
    && typeof record.startIdentity === "string"
    && /^[A-Za-z0-9._:-]{1,128}$/.test(record.startIdentity);
}

function validateDisplayName(value: unknown, allowDefault = false) {
  if (typeof value !== "string"
    || value.length === 0
    || value !== value.normalize("NFC")
    || value !== value.trim()
    || value.replace(/\s+/gu, " ") !== value
    || Array.from(value).length > 64
    || Buffer.byteLength(value, "utf8") > 256
    || value === "."
    || value === ".."
    || /[\\/]/u.test(value)) {
    throw new ProfileRegistryError(
      "precondition",
      "Profile display names must be canonical, bounded, single-line text without path separators.",
    );
  }
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point <= 0x1f || (point >= 0x7f && point <= 0x9f)
      || point === 0x2028 || point === 0x2029
      || (point >= 0x202a && point <= 0x202e)
      || (point >= 0x2066 && point <= 0x2069)) {
      throw new ProfileRegistryError("precondition", "Profile display names cannot contain control characters.");
    }
  }
  if (!allowDefault && value.localeCompare(DEFAULT_PROFILE_DISPLAY_NAME, "en", { sensitivity: "accent" }) === 0) {
    throw new ProfileRegistryError("protected", "The Default profile identity is reserved.");
  }
  return value;
}

function displayNameKey(value: string) {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function validGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function requireExpectedGeneration(value: unknown) {
  if (!validGeneration(value)) {
    throw new ProfileRegistryError("precondition", "A valid profile registry generation is required.");
  }
  return value;
}

function freezeProfile(profile: ProfileMetadata): ProfileMetadata {
  return Object.freeze({ ...profile });
}

function freezeSnapshot(snapshot: ProfileRegistrySnapshot): ProfileRegistrySnapshot {
  return Object.freeze({
    ...snapshot,
    profiles: Object.freeze(snapshot.profiles.map(freezeProfile)),
  });
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]) {
  return Object.keys(record).sort().join(",") === [...expected].sort().join(",");
}

function parseProfile(value: unknown): ProfileMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidRegistryFileError();
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["createdAt", "displayName", "id", "kind", "protected", "updatedAt"])
    || !isCanonicalUuid(record.id)
    || (record.kind !== "default" && record.kind !== "personal" && record.kind !== "testing")
    || typeof record.protected !== "boolean"
    || !isCanonicalTimestamp(record.createdAt)
    || !isCanonicalTimestamp(record.updatedAt)
    || Date.parse(record.updatedAt) < Date.parse(record.createdAt)) {
    throw new InvalidRegistryFileError();
  }
  let displayName: string;
  try {
    displayName = validateDisplayName(record.displayName, record.kind === "default");
  } catch {
    throw new InvalidRegistryFileError();
  }
  if ((record.kind === "default") !== record.protected) {
    throw new InvalidRegistryFileError();
  }
  return freezeProfile({
    id: record.id,
    displayName,
    kind: record.kind,
    protected: record.protected,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function parseSnapshot(value: unknown): ProfileRegistrySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidRegistryFileError();
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["activeProfileId", "createdAt", "generation", "profiles", "schemaVersion", "updatedAt"])
    || record.schemaVersion !== PROFILE_REGISTRY_SCHEMA_VERSION
    || !validGeneration(record.generation)
    || !isCanonicalUuid(record.activeProfileId)
    || !isCanonicalTimestamp(record.createdAt)
    || !isCanonicalTimestamp(record.updatedAt)
    || Date.parse(record.updatedAt) < Date.parse(record.createdAt)
    || !Array.isArray(record.profiles)
    || record.profiles.length === 0
    || record.profiles.length > PROFILE_REGISTRY_MAX_PROFILES) {
    throw new InvalidRegistryFileError();
  }
  const profiles = record.profiles.map(parseProfile);
  const ids = new Set(profiles.map((profile) => profile.id));
  const names = new Set(profiles.map((profile) => displayNameKey(profile.displayName)));
  const defaults = profiles.filter((profile) => profile.kind === "default");
  if (ids.size !== profiles.length
    || names.size !== profiles.length
    || defaults.length !== 1
    || profiles[0]?.kind !== "default"
    || !ids.has(record.activeProfileId)) {
    throw new InvalidRegistryFileError();
  }
  return freezeSnapshot({
    schemaVersion: PROFILE_REGISTRY_SCHEMA_VERSION,
    generation: record.generation,
    activeProfileId: record.activeProfileId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    profiles,
  });
}

function parseLock(value: unknown): LockRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProfileRegistryError("unsafe-storage", "The profile registry lock is invalid and was left untouched.");
  }
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["acquiredAt", "owner", "schemaVersion", "token"])
    || record.schemaVersion !== 1
    || !validOwnerIdentity(record.owner)
    || typeof record.token !== "string"
    || !/^[A-Za-z0-9_-]{32,128}$/.test(record.token)
    || !isCanonicalTimestamp(record.acquiredAt)) {
    throw new ProfileRegistryError("unsafe-storage", "The profile registry lock is invalid and was left untouched.");
  }
  return Object.freeze({
    schemaVersion: 1,
    owner: Object.freeze({ ...record.owner }),
    token: record.token,
    acquiredAt: record.acquiredAt,
  });
}

function sameEntry(left: Stats, right: Stats) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertOwned(status: Stats, label: string) {
  const getuid = process.getuid;
  if (posixGuards && getuid && status.uid !== getuid.call(process)) {
    throw new ProfileRegistryError("unsafe-storage", `${label} must be owned by the current local user.`);
  }
}

function directoryFlags() {
  return constants.O_RDONLY
    | (posixGuards ? constants.O_NOFOLLOW : 0)
    | (posixGuards ? constants.O_DIRECTORY : 0);
}

function verifyDirectory(path: string, label: string, ownerPrivate: boolean) {
  let descriptor: number | undefined;
  try {
    const status = lstatSync(path);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new ProfileRegistryError("unsafe-storage", `${label} must be a real local directory.`);
    }
    assertOwned(status, label);
    descriptor = openSync(path, directoryFlags());
    const opened = fstatSync(descriptor);
    if (!opened.isDirectory() || !sameEntry(status, opened)) {
      throw new ProfileRegistryError("unsafe-storage", `${label} changed while it was being verified.`);
    }
    if (ownerPrivate && posixGuards && (opened.mode & 0o077) !== 0) {
      throw new ProfileRegistryError("unsafe-storage", `${label} must be owner-private.`);
    }
    return Object.freeze({ dev: opened.dev, ino: opened.ino });
  } catch (error) {
    if (error instanceof ProfileRegistryError) throw error;
    if (errorCode(error) === "ELOOP") {
      throw new ProfileRegistryError("unsafe-storage", `${label} cannot be a symbolic link.`);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function verifySameDirectory(path: string, expected: Readonly<{ dev: number; ino: number }>, label: string) {
  const current = verifyDirectory(path, label, true);
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new ProfileRegistryError("unsafe-storage", `${label} changed during a profile registry operation.`);
  }
}

function syncDirectory(path: string) {
  syncDirectoryMetadata(path, "Profile registry durability directory");
}

function verifyPrivateFile(path: string, maximumBytes: number, label: string, allowLockClaims = false) {
  let descriptor: number | undefined;
  try {
    const status = lstatSync(path);
    if (status.isSymbolicLink()
      || !status.isFile()
      || (allowLockClaims ? status.nlink < 1 : status.nlink !== 1)
      || status.size > maximumBytes) {
      throw new ProfileRegistryError(
        "unsafe-storage",
        `${label} must be a bounded, non-linked regular file.`,
      );
    }
    assertOwned(status, label);
    if (posixGuards && (status.mode & 0o077) !== 0) {
      throw new ProfileRegistryError("unsafe-storage", `${label} must be owner-private.`);
    }
    descriptor = openSync(path, constants.O_RDONLY | (posixGuards ? constants.O_NOFOLLOW : 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile()
      || (allowLockClaims ? opened.nlink < 1 : opened.nlink !== 1)
      || opened.size > maximumBytes
      || !sameEntry(status, opened)) {
      throw new ProfileRegistryError("unsafe-storage", `${label} changed while it was being read.`);
    }
    const content = readFileSync(descriptor, { encoding: "utf8" });
    const after = fstatSync(descriptor);
    if (!sameEntry(opened, after) || after.size !== opened.size || Buffer.byteLength(content, "utf8") !== opened.size) {
      throw new ProfileRegistryError("unsafe-storage", `${label} changed while it was being read.`);
    }
    return content;
  } catch (error) {
    if (error instanceof ProfileRegistryError) throw error;
    if (errorCode(error) === "ELOOP") {
      throw new ProfileRegistryError("unsafe-storage", `${label} cannot be a symbolic link.`);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readRegistryFile(path: string, label: string): FileRead {
  let content: string;
  try {
    content = verifyPrivateFile(path, maximumRegistryBytes, label);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return Object.freeze({ kind: "missing" });
    throw error;
  }
  try {
    return Object.freeze({ kind: "valid", snapshot: parseSnapshot(JSON.parse(content)) });
  } catch (error) {
    if (error instanceof ProfileRegistryError) throw error;
    return Object.freeze({ kind: "invalid" });
  }
}

function snapshotsEqual(left: ProfileRegistrySnapshot, right: ProfileRegistrySnapshot) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function selectRegistryRead(primary: FileRead, recovery: FileRead): RegistryRead | null {
  if (primary.kind === "missing" && recovery.kind === "missing") return null;
  const valid = [
    ...(primary.kind === "valid" ? [{ snapshot: primary.snapshot, source: "primary" as const }] : []),
    ...(recovery.kind === "valid" ? [{ snapshot: recovery.snapshot, source: "recovery" as const }] : []),
  ];
  if (valid.length === 0) {
    throw new ProfileRegistryError("invalid", "The profile registry and its recovery copy are invalid.");
  }
  if (valid.length === 2
    && valid[0]!.snapshot.generation === valid[1]!.snapshot.generation
    && !snapshotsEqual(valid[0]!.snapshot, valid[1]!.snapshot)) {
    throw new ProfileRegistryError("invalid", "The profile registry has conflicting copies at the same generation.");
  }
  return valid.reduce((newest, candidate) => (
    candidate.snapshot.generation > newest.snapshot.generation ? candidate : newest
  ));
}

function serializedSnapshot(snapshot: ProfileRegistrySnapshot) {
  const content = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (Buffer.byteLength(content, "utf8") > maximumRegistryBytes) {
    throw new ProfileRegistryError("invalid", "The profile registry exceeds its local size limit.");
  }
  return content;
}

function validateExistingTarget(path: string, maximumBytes: number, label: string) {
  try {
    verifyPrivateFile(path, maximumBytes, label);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function atomicWrite(
  path: string,
  content: string,
  registryRoot: string,
  directoryIdentity: Readonly<{ dev: number; ino: number }>,
) {
  validateExistingTarget(path, maximumRegistryBytes, "Profile registry file");
  const temporary = join(registryRoot, `.registry-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (posixGuards ? constants.O_NOFOLLOW : 0),
      privateFileMode,
    );
    if (posixGuards) fchmodSync(descriptor, privateFileMode);
    writeFileSync(descriptor, content, { encoding: "utf8" });
    fsyncSync(descriptor);
    const written = fstatSync(descriptor);
    if (!written.isFile() || written.nlink !== 1 || written.size !== Buffer.byteLength(content, "utf8")) {
      throw new ProfileRegistryError("unsafe-storage", "The profile registry temporary file is unsafe.");
    }
    closeSync(descriptor);
    descriptor = undefined;
    verifySameDirectory(registryRoot, directoryIdentity, "Profile registry directory");
    verifyPrivateFile(temporary, maximumRegistryBytes, "Profile registry temporary file");
    validateExistingTarget(path, maximumRegistryBytes, "Profile registry file");
    renameSync(temporary, path);
    verifySameDirectory(registryRoot, directoryIdentity, "Profile registry directory");
    verifyPrivateFile(path, maximumRegistryBytes, "Profile registry file");
    syncDirectory(registryRoot);
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* Preserve the original failure. */ }
    }
    try { unlinkSync(temporary); } catch { /* The temporary may not exist. */ }
    throw error;
  }
}

function defaultInspectOwner(owner: ProfileRegistryOwnerIdentity): ProfileRegistryOwnerState {
  if (owner.pid === process.pid) {
    return owner.startIdentity === localStartIdentity ? "same-start" : "different-start";
  }
  try {
    process.kill(owner.pid, 0);
    return "unknown";
  } catch (error) {
    return errorCode(error) === "ESRCH" ? "dead" : "unknown";
  }
}

function lockContent(record: LockRecord) {
  return `${JSON.stringify(record)}\n`;
}

function sameLockRecord(left: LockRecord, right: LockRecord) {
  return left.schemaVersion === right.schemaVersion
    && left.token === right.token
    && left.acquiredAt === right.acquiredAt
    && left.owner.pid === right.owner.pid
    && left.owner.startIdentity === right.owner.startIdentity;
}

function readLock(path: string, allowLockClaims = false) {
  let content: string;
  try {
    content = verifyPrivateFile(path, maximumLockBytes, "Profile registry lock", allowLockClaims);
  } catch (error) {
    if (errorCode(error) === "ENOENT") throw error;
    throw error;
  }
  try {
    return parseLock(JSON.parse(content));
  } catch (error) {
    if (error instanceof ProfileRegistryError) throw error;
    throw new ProfileRegistryError("unsafe-storage", "The profile registry lock is invalid and was left untouched.");
  }
}

function claimNames(layout: ProfileRegistryLayout) {
  return readdirSync(layout.registryRoot)
    .filter((name) => lockClaimNamePattern.test(name))
    .sort();
}

function verifyClaimFile(path: string) {
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isFile() || status.size > maximumLockBytes) {
    throw new ProfileRegistryError("unsafe-storage", "A profile registry lock claim is unsafe and was left untouched.");
  }
  assertOwned(status, "Profile registry lock claim");
  if (posixGuards && (status.mode & 0o077) !== 0) {
    throw new ProfileRegistryError("unsafe-storage", "A profile registry lock claim must be owner-private.");
  }
  return status;
}

function cleanupDetachedLockClaims(
  layout: ProfileRegistryLayout,
  directoryIdentity: Readonly<{ dev: number; ino: number }>,
) {
  let canonical: Stats | undefined;
  try { canonical = lstatSync(layout.lockFile); }
  catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
  let changed = false;
  for (const name of claimNames(layout)) {
    const path = join(layout.registryRoot, name);
    let claim: Stats;
    try { claim = verifyClaimFile(path); }
    catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    if (canonical && sameEntry(canonical, claim)) continue;
    verifySameDirectory(layout.registryRoot, directoryIdentity, "Profile registry directory");
    try { unlinkSync(path); changed = true; }
    catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
  }
  if (changed) syncDirectory(layout.registryRoot);
}

function normalizeStaleLockClaims(
  layout: ProfileRegistryLayout,
  expected: LockRecord,
  directoryIdentity: Readonly<{ dev: number; ino: number }>,
) {
  for (let attempt = 0; attempt < lockAcquisitionAttempts; attempt += 1) {
    const before = lstatSync(layout.lockFile);
    const current = readLock(layout.lockFile, true);
    const afterRead = lstatSync(layout.lockFile);
    if (!sameEntry(before, afterRead) || !sameLockRecord(current, expected)) return false;
    if (afterRead.nlink === 1) return true;

    let removedClaim = false;
    for (const name of claimNames(layout)) {
      const path = join(layout.registryRoot, name);
      let claim: Stats;
      try { claim = verifyClaimFile(path); }
      catch (error) {
        if (errorCode(error) === "ENOENT") continue;
        throw error;
      }
      if (!sameEntry(before, claim)) continue;
      verifySameDirectory(layout.registryRoot, directoryIdentity, "Profile registry directory");
      try { unlinkSync(path); removedClaim = true; }
      catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
    }
    if (!removedClaim) {
      throw new ProfileRegistryError(
        "unsafe-storage",
        "The profile registry lock has an unrecognized hard link and was left untouched.",
      );
    }
    syncDirectory(layout.registryRoot);
    let finalLock: Stats;
    try { finalLock = lstatSync(layout.lockFile); }
    catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
    if (!sameEntry(before, finalLock)) return false;
    if (finalLock.nlink === 1) return true;
  }
  return false;
}

function publishLock(
  layout: ProfileRegistryLayout,
  record: LockRecord,
  directoryIdentity: Readonly<{ dev: number; ino: number }>,
) {
  const temporary = join(layout.registryRoot, `.lock-${record.token}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (posixGuards ? constants.O_NOFOLLOW : 0),
      privateFileMode,
    );
    if (posixGuards) fchmodSync(descriptor, privateFileMode);
    writeFileSync(descriptor, lockContent(record), { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    verifySameDirectory(layout.registryRoot, directoryIdentity, "Profile registry directory");
    verifyPrivateFile(temporary, maximumLockBytes, "Profile registry temporary lock");
    linkSync(temporary, layout.lockFile);
    unlinkSync(temporary);
    verifyPrivateFile(layout.lockFile, maximumLockBytes, "Profile registry lock");
    syncDirectory(layout.registryRoot);
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* Preserve the original failure. */ }
    }
    try { unlinkSync(temporary); } catch { /* The temporary may not exist. */ }
    throw error;
  }
}

function unlinkMatchingLock(
  layout: ProfileRegistryLayout,
  expected: LockRecord,
  directoryIdentity: Readonly<{ dev: number; ino: number }>,
  onLockClaimForTests?: ProfileRegistryOptions["onLockClaimForTests"],
) {
  const before = lstatSync(layout.lockFile);
  const current = readLock(layout.lockFile);
  const after = lstatSync(layout.lockFile);
  if (!sameEntry(before, after) || !sameLockRecord(current, expected)) return false;

  // Link the exact inspected inode to a private, unguessable claim before
  // unlinking the public lock name. While that name still exists, a publisher
  // cannot replace it. Competing reclaimers increase the inode link count, so
  // at most one claimant can observe the required two-link state and unlink.
  // A replacement made after inspection points at a different inode and is
  // therefore never removed by this call.
  let claimFile: string | undefined;
  for (let attempt = 0; attempt < lockAcquisitionAttempts; attempt += 1) {
    const candidate = join(layout.registryRoot, `.lock-claim-${randomBytes(24).toString("hex")}.tmp`);
    try {
      linkSync(layout.lockFile, candidate);
      claimFile = candidate;
      break;
    } catch (error) {
      if (errorCode(error) === "EEXIST") continue;
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
  }
  if (claimFile === undefined) {
    throw new ProfileRegistryError("active-lock", "A unique profile registry lock claim could not be created.");
  }

  let removed = false;
  try {
    const claimed = lstatSync(claimFile);
    if (!sameEntry(before, claimed)) return false;

    onLockClaimForTests?.({
      lockFile: layout.lockFile,
      claimFile,
      expectedToken: expected.token,
    });

    verifySameDirectory(layout.registryRoot, directoryIdentity, "Profile registry directory");
    const finalLock = lstatSync(layout.lockFile);
    const finalClaim = lstatSync(claimFile);
    if (!sameEntry(before, finalLock)
      || !sameEntry(before, finalClaim)
      || finalLock.nlink !== 2
      || finalClaim.nlink !== 2) return false;
    unlinkSync(layout.lockFile);
    removed = true;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  } finally {
    try {
      unlinkSync(claimFile);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  syncDirectory(layout.registryRoot);
  return removed;
}

function requireCanonicalManagedRoot(managedRoot: string) {
  if (typeof managedRoot !== "string"
    || managedRoot.includes("\0")
    || !isAbsolute(managedRoot)
    || resolve(managedRoot) !== managedRoot) {
    throw new ProfileRegistryError("precondition", "The profile registry requires one canonical absolute managed root.");
  }
  return managedRoot;
}

function pathWithin(root: string, candidate: string) {
  const child = relative(root, candidate);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function layoutFor(managedRoot: string): ProfileRegistryLayout {
  const root = requireCanonicalManagedRoot(managedRoot);
  const registryRoot = join(root, PROFILE_REGISTRY_DIRECTORY_NAME);
  const profilesRoot = join(registryRoot, PROFILE_DATA_DIRECTORY_NAME);
  const layout = Object.freeze({
    managedRoot: root,
    registryRoot,
    profilesRoot,
    registryFile: join(registryRoot, registryFileName),
    recoveryFile: join(registryRoot, recoveryFileName),
    lockFile: join(registryRoot, lockFileName),
  });
  if (Object.values(layout).some((path) => !pathWithin(root, path))) {
    throw new ProfileRegistryError("unsafe-storage", "The profile registry layout escaped its managed root.");
  }
  return layout;
}

function currentTimestamp(now: () => Date) {
  const value = now();
  const timestamp = value.toISOString();
  if (!Number.isFinite(value.getTime()) || !isCanonicalTimestamp(timestamp)) {
    throw new ProfileRegistryError("precondition", "A valid profile registry timestamp is required.");
  }
  return timestamp;
}

function mutationTimestamp(now: () => Date, current: ProfileRegistrySnapshot) {
  const timestamp = currentTimestamp(now);
  return Date.parse(timestamp) < Date.parse(current.updatedAt) ? current.updatedAt : timestamp;
}

export type ProfileRegistry = Readonly<{
  layout: ProfileRegistryLayout;
  allocateProfileId: () => string;
  profileRoot: (profileId: string) => string;
  inspect: () => ProfileRegistryInspection;
  read: () => ProfileRegistrySnapshot | null;
  readGeneration: (generation: number) => ProfileRegistrySnapshot | null;
  initializeDefault: (input?: Readonly<{ profileId?: string; displayName?: string }>) => ProfileRegistrySnapshot;
  recover: (input: Readonly<{ expectedGeneration: number }>) => ProfileRegistrySnapshot;
  create: (input: Readonly<{
    displayName: string;
    kind: CreatableProfileKind;
    expectedGeneration: number;
    profileId?: string;
  }>) => ProfileRegistrySnapshot;
  rename: (input: Readonly<{
    profileId: string;
    displayName: string;
    expectedGeneration: number;
  }>) => ProfileRegistrySnapshot;
  switchActive: (input: Readonly<{
    profileId: string;
    expectedGeneration: number;
  }>) => ProfileRegistrySnapshot;
  bump: (input: Readonly<{ expectedGeneration: number }>) => ProfileRegistrySnapshot;
  remove: (input: Readonly<{
    profileId: string;
    expectedGeneration: number;
  }>) => ProfileRegistrySnapshot;
}>;

export function openProfileRegistry(options: ProfileRegistryOptions): ProfileRegistry {
  const layout = layoutFor(options.managedRoot);
  const ownerIdentity = options.ownerIdentity ?? Object.freeze({ pid: process.pid, startIdentity: localStartIdentity });
  if (!validOwnerIdentity(ownerIdentity)) {
    throw new ProfileRegistryError("precondition", "The profile registry owner/start identity is invalid.");
  }
  const inspectOwner = options.inspectOwner ?? defaultInspectOwner;
  const now = options.now ?? (() => new Date());
  const uuid = options.uuid ?? randomUUID;
  const lockToken = options.lockToken ?? (() => randomBytes(32).toString("base64url"));
  const onLockClaimForTests = options.onLockClaimForTests;

  const verifyRoot = () => verifyDirectory(layout.managedRoot, "Profile registry managed root", false);

  const inspectInternal = (): ProfileRegistryInspection => {
    try {
      verifyRoot();
    } catch (error) {
      if (errorCode(error) === "ENOENT") return Object.freeze({ kind: "setup-required" });
      throw error;
    }
    try {
      verifyDirectory(layout.registryRoot, "Profile registry directory", true);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return Object.freeze({ kind: "setup-required" });
      throw error;
    }
    const selected = selectRegistryRead(
      readRegistryFile(layout.registryFile, "Profile registry"),
      readRegistryFile(layout.recoveryFile, "Profile registry recovery copy"),
    );
    return selected === null
      ? Object.freeze({ kind: "setup-required" })
      : Object.freeze({ kind: "ready", snapshot: selected.snapshot, source: selected.source });
  };

  const ensureInitializationDirectory = () => {
    verifyRoot();
    try {
      mkdirSync(layout.registryRoot, { mode: privateDirectoryMode });
      if (posixGuards) chmodSync(layout.registryRoot, privateDirectoryMode);
      syncDirectory(layout.managedRoot);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    return verifyDirectory(layout.registryRoot, "Profile registry directory", true);
  };

  const acquireLock = (allowDirectoryCreation: boolean) => {
    const directoryIdentity = allowDirectoryCreation
      ? ensureInitializationDirectory()
      : (() => {
        verifyRoot();
        try {
          return verifyDirectory(layout.registryRoot, "Profile registry directory", true);
        } catch (error) {
          if (errorCode(error) === "ENOENT") {
            throw new ProfileRegistryError("setup-required", "The profile registry has not been initialized.");
          }
          throw error;
        }
      })();
    const record = Object.freeze({
      schemaVersion: 1 as const,
      owner: Object.freeze({ ...ownerIdentity }),
      token: lockToken(),
      acquiredAt: currentTimestamp(now),
    });
    if (!parseLock(record)) {
      throw new ProfileRegistryError("precondition", "The profile registry lock identity is invalid.");
    }
    let acquired = false;
    for (let attempt = 0; attempt < lockAcquisitionAttempts; attempt += 1) {
      cleanupDetachedLockClaims(layout, directoryIdentity);
      try {
        publishLock(layout, record, directoryIdentity);
        acquired = true;
        break;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        const existing = readLock(layout.lockFile, true);
        let state: ProfileRegistryOwnerState;
        try { state = inspectOwner(existing.owner); }
        catch { state = "unknown"; }
        if (state === "same-start" || state === "unknown") {
          throw new ProfileRegistryError(
            "active-lock",
            "Another live or unverifiable owner holds the profile registry lock.",
          );
        }
        try {
          if (!normalizeStaleLockClaims(layout, existing, directoryIdentity)) continue;
          if (!unlinkMatchingLock(layout, existing, directoryIdentity, onLockClaimForTests)) continue;
        } catch (cleanupError) {
          if (errorCode(cleanupError) === "ENOENT") continue;
          throw cleanupError;
        }
      }
    }
    if (!acquired) {
      throw new ProfileRegistryError("active-lock", "The profile registry lock changed during bounded recovery.");
    }
    let released = false;
    return Object.freeze({
      directoryIdentity,
      release() {
        if (released) return false;
        try {
          const removed = unlinkMatchingLock(layout, record, directoryIdentity, onLockClaimForTests);
          released = true;
          return removed;
        } catch (error) {
          if (errorCode(error) === "ENOENT") {
            released = true;
            return false;
          }
          throw error;
        }
      },
    });
  };

  const requireCurrent = () => {
    const inspection = inspectInternal();
    if (inspection.kind !== "ready") {
      throw new ProfileRegistryError("setup-required", "The profile registry has not been initialized.");
    }
    return inspection;
  };

  const checkGeneration = (snapshot: ProfileRegistrySnapshot, expected: unknown) => {
    const expectedGeneration = requireExpectedGeneration(expected);
    if (snapshot.generation !== expectedGeneration) {
      throw new ProfileRegistryError("conflict", "The profile registry changed before this operation completed.");
    }
  };

  const persistMutation = (
    current: ProfileRegistryInspection & { kind: "ready" },
    next: ProfileRegistrySnapshot,
    directoryIdentity: Readonly<{ dev: number; ino: number }>,
  ) => {
    let validated: ProfileRegistrySnapshot;
    try {
      validated = parseSnapshot(JSON.parse(serializedSnapshot(next)));
    } catch {
      throw new ProfileRegistryError("invalid", "The next profile registry snapshot is invalid and was not written.");
    }
    if (current.source === "primary") {
      atomicWrite(layout.recoveryFile, serializedSnapshot(current.snapshot), layout.registryRoot, directoryIdentity);
    }
    atomicWrite(layout.registryFile, serializedSnapshot(validated), layout.registryRoot, directoryIdentity);
    return validated;
  };

  const mutate = (
    expectedGeneration: unknown,
    operation: (current: ProfileRegistrySnapshot, timestamp: string) => ProfileRegistrySnapshot,
  ) => {
    const lease = acquireLock(false);
    try {
      const current = requireCurrent();
      if (current.source === "recovery") {
        throw new ProfileRegistryError(
          "invalid",
          "Profile registry Recovery is required before another profile change can be made.",
        );
      }
      checkGeneration(current.snapshot, expectedGeneration);
      const next = operation(current.snapshot, mutationTimestamp(now, current.snapshot));
      if (next === current.snapshot) return next;
      return persistMutation(current, next, lease.directoryIdentity);
    } finally {
      lease.release();
    }
  };

  const allocateProfileId = () => requireProfileId(uuid());

  return Object.freeze({
    layout,
    allocateProfileId,
    profileRoot(profileId: string) {
      const id = requireProfileId(profileId);
      const path = join(layout.profilesRoot, id);
      if (!pathWithin(layout.profilesRoot, path)) {
        throw new ProfileRegistryError("unsafe-storage", "The profile root escaped the managed profile directory.");
      }
      return path;
    },
    inspect: inspectInternal,
    read() {
      const inspection = inspectInternal();
      return inspection.kind === "ready" ? inspection.snapshot : null;
    },
    readGeneration(generation: number) {
      const expectedGeneration = requireExpectedGeneration(generation);
      try {
        verifyRoot();
      } catch (error) {
        if (errorCode(error) === "ENOENT") return null;
        throw error;
      }
      try {
        verifyDirectory(layout.registryRoot, "Profile registry directory", true);
      } catch (error) {
        if (errorCode(error) === "ENOENT") return null;
        throw error;
      }
      const primary = readRegistryFile(layout.registryFile, "Profile registry");
      const recovery = readRegistryFile(layout.recoveryFile, "Profile registry recovery copy");
      if (primary.kind === "valid"
        && recovery.kind === "valid"
        && primary.snapshot.generation === recovery.snapshot.generation
        && !snapshotsEqual(primary.snapshot, recovery.snapshot)) {
        throw new ProfileRegistryError("invalid", "The profile registry has conflicting copies at the same generation.");
      }
      const matching = [primary, recovery]
        .filter((file): file is FileRead & { kind: "valid" } => (
          file.kind === "valid" && file.snapshot.generation === expectedGeneration
        ))
        .map((file) => file.snapshot);
      if (matching.length === 0) return null;
      if (matching.length === 2 && !snapshotsEqual(matching[0]!, matching[1]!)) {
        throw new ProfileRegistryError("invalid", "The profile registry has conflicting copies at the requested generation.");
      }
      return matching[0]!;
    },
    initializeDefault(input = {}) {
      const displayName = validateDisplayName(input.displayName ?? DEFAULT_PROFILE_DISPLAY_NAME, true);
      const profileId = input.profileId === undefined ? allocateProfileId() : requireProfileId(input.profileId);
      const lease = acquireLock(true);
      try {
        if (inspectInternal().kind === "ready") {
          throw new ProfileRegistryError("already-initialized", "The profile registry is already initialized.");
        }
        const timestamp = currentTimestamp(now);
        const profile = freezeProfile({
          id: profileId,
          displayName,
          kind: "default",
          protected: true,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        const snapshot = freezeSnapshot({
          schemaVersion: PROFILE_REGISTRY_SCHEMA_VERSION,
          generation: 1,
          activeProfileId: profileId,
          createdAt: timestamp,
          updatedAt: timestamp,
          profiles: [profile],
        });
        atomicWrite(layout.registryFile, serializedSnapshot(snapshot), layout.registryRoot, lease.directoryIdentity);
        return snapshot;
      } finally {
        lease.release();
      }
    },
    recover(input) {
      const lease = acquireLock(false);
      try {
        const current = requireCurrent();
        checkGeneration(current.snapshot, input.expectedGeneration);
        if (current.source === "recovery") {
          atomicWrite(
            layout.registryFile,
            serializedSnapshot(current.snapshot),
            layout.registryRoot,
            lease.directoryIdentity,
          );
        }
        return current.snapshot;
      } finally {
        lease.release();
      }
    },
    create(input) {
      const displayName = validateDisplayName(input.displayName);
      if (input.kind !== "personal" && input.kind !== "testing") {
        throw new ProfileRegistryError("precondition", "New profiles must be explicitly personal or testing.");
      }
      const profileId = input.profileId === undefined ? allocateProfileId() : requireProfileId(input.profileId);
      return mutate(input.expectedGeneration, (current, timestamp) => {
        if (current.profiles.length >= PROFILE_REGISTRY_MAX_PROFILES) {
          throw new ProfileRegistryError("precondition", "The local profile registry is at capacity.");
        }
        if (current.profiles.some((profile) => profile.id === profileId)) {
          throw new ProfileRegistryError("precondition", "That opaque profile ID is already registered.");
        }
        if (current.profiles.some((profile) => displayNameKey(profile.displayName) === displayNameKey(displayName))) {
          throw new ProfileRegistryError("duplicate-name", "Profile display names must be unique on this device.");
        }
        return freezeSnapshot({
          ...current,
          generation: current.generation + 1,
          updatedAt: timestamp,
          profiles: [...current.profiles, freezeProfile({
            id: profileId,
            displayName,
            kind: input.kind,
            protected: false,
            createdAt: timestamp,
            updatedAt: timestamp,
          })],
        });
      });
    },
    rename(input) {
      const profileId = requireProfileId(input.profileId);
      const displayName = validateDisplayName(input.displayName, true);
      return mutate(input.expectedGeneration, (current, timestamp) => {
        const existing = current.profiles.find((profile) => profile.id === profileId);
        if (!existing) throw new ProfileRegistryError("not-found", "The requested profile does not exist.");
        if (existing.kind !== "default" && displayNameKey(displayName) === displayNameKey(DEFAULT_PROFILE_DISPLAY_NAME)) {
          throw new ProfileRegistryError("protected", "The Default display label is reserved for the protected profile.");
        }
        if (current.profiles.some((profile) => (
          profile.id !== profileId && displayNameKey(profile.displayName) === displayNameKey(displayName)
        ))) {
          throw new ProfileRegistryError("duplicate-name", "Profile display names must be unique on this device.");
        }
        if (existing.displayName === displayName) return current;
        return freezeSnapshot({
          ...current,
          generation: current.generation + 1,
          updatedAt: timestamp,
          profiles: current.profiles.map((profile) => profile.id === profileId
            ? freezeProfile({ ...profile, displayName, updatedAt: timestamp })
            : profile),
        });
      });
    },
    switchActive(input) {
      const profileId = requireProfileId(input.profileId);
      return mutate(input.expectedGeneration, (current, timestamp) => {
        if (!current.profiles.some((profile) => profile.id === profileId)) {
          throw new ProfileRegistryError("not-found", "The requested profile does not exist.");
        }
        if (current.activeProfileId === profileId) return current;
        return freezeSnapshot({
          ...current,
          generation: current.generation + 1,
          activeProfileId: profileId,
          updatedAt: timestamp,
        });
      });
    },
    bump(input) {
      return mutate(input.expectedGeneration, (current, timestamp) => freezeSnapshot({
        ...current,
        generation: current.generation + 1,
        updatedAt: timestamp,
      }));
    },
    remove(input) {
      const profileId = requireProfileId(input.profileId);
      return mutate(input.expectedGeneration, (current, timestamp) => {
        const existing = current.profiles.find((profile) => profile.id === profileId);
        if (!existing) throw new ProfileRegistryError("not-found", "The requested profile does not exist.");
        if (existing.protected) throw new ProfileRegistryError("protected", "The Default profile identity cannot be removed.");
        if (current.activeProfileId === profileId) {
          throw new ProfileRegistryError("precondition", "The active profile must be switched before it can be removed.");
        }
        return freezeSnapshot({
          ...current,
          generation: current.generation + 1,
          updatedAt: timestamp,
          profiles: current.profiles.filter((profile) => profile.id !== profileId),
        });
      });
    },
  });
}

export function inspectProfileRegistry(managedRoot: string): ProfileRegistryInspection {
  return openProfileRegistry({ managedRoot }).inspect();
}
