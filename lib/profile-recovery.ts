import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PROFILE_DATA_DIRECTORY_NAME } from "./profile-registry.ts";

export const PROFILE_OPERATION_RECOVERY_SCHEMA_VERSION = 1 as const;
export const PROFILE_OPERATION_RECOVERY_FILE = "operation-recovery.json";

export type ProfileRecoveryOperation = "default-migration" | "create" | "restore" | "reset" | "delete";
export type ProfileRecoveryPhase =
  | "prepared"
  | "profile-root-created"
  | "profile-root-restored"
  | "tombstone-moved"
  | "replacement-created"
  | "registry-committed";

export type ProfileRecoveryJournal = Readonly<{
  schemaVersion: typeof PROFILE_OPERATION_RECOVERY_SCHEMA_VERSION;
  kind: "rangabot-profile-operation-recovery";
  operationId: string;
  operation: ProfileRecoveryOperation;
  phase: ProfileRecoveryPhase;
  profileId: string;
  expectedGeneration: number;
  tombstoneName: string | null;
  backupManifestSha256: string | null;
  createdAt: string;
  updatedAt: string;
}>;

const journalMaximumBytes = 16 * 1024;
const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;
const posixGuards = process.platform !== "win32";

function errorCode(error: unknown) {
  return (error as NodeJS.ErrnoException).code;
}

function pathInside(root: string, candidate: string) {
  const child = relative(root, candidate);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

function canonicalUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function canonicalTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function assertOwnedPrivateDirectory(path: string, label: string, allowMissing = false) {
  let status;
  try { status = lstatSync(path); }
  catch (error) {
    if (allowMissing && errorCode(error) === "ENOENT") return null;
    throw error;
  }
  if (status.isSymbolicLink() || !status.isDirectory() || status.nlink < 1) {
    throw new Error(`${label} must be a real local directory.`);
  }
  if (posixGuards && process.getuid && (status.uid !== process.getuid() || (status.mode & 0o077) !== 0)) {
    throw new Error(`${label} must be owner-private.`);
  }
  return status;
}

function assertOwnedPrivateFile(path: string, label: string) {
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1 || status.size < 2 || status.size > journalMaximumBytes) {
    throw new Error(`${label} must be a bounded, non-linked regular file.`);
  }
  if (posixGuards && process.getuid && (status.uid !== process.getuid() || (status.mode & 0o077) !== 0)) {
    throw new Error(`${label} must be owner-private.`);
  }
  return status;
}

function directoryFlags() {
  return constants.O_RDONLY | (posixGuards ? constants.O_NOFOLLOW : 0);
}

export function syncProfileDirectory(path: string) {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, directoryFlags());
    const status = fstatSync(descriptor);
    if (!status.isDirectory()) throw new Error("Profile durability boundary is not a directory.");
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function layout(managedRoot: string) {
  const root = resolve(managedRoot);
  const registryRoot = join(root, "profiles-v1");
  const profilesRoot = join(registryRoot, PROFILE_DATA_DIRECTORY_NAME);
  const tombstonesRoot = join(registryRoot, "tombstones");
  const recoveryRoot = join(registryRoot, "recovery");
  const journalPath = join(registryRoot, PROFILE_OPERATION_RECOVERY_FILE);
  if (![registryRoot, profilesRoot, tombstonesRoot, recoveryRoot, journalPath].every((path) => pathInside(root, path))) {
    throw new Error("Profile Recovery layout escaped its managed root.");
  }
  return Object.freeze({ managedRoot: root, registryRoot, profilesRoot, tombstonesRoot, recoveryRoot, journalPath });
}

function ensurePrivateDirectory(path: string, parent: string) {
  if (!pathInside(parent, path)) throw new Error("Profile Recovery directory escaped its private parent.");
  assertOwnedPrivateDirectory(parent, "Profile Recovery parent");
  try { mkdirSync(path, { mode: privateDirectoryMode }); }
  catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
  if (posixGuards) chmodSync(path, privateDirectoryMode);
  assertOwnedPrivateDirectory(path, "Profile Recovery directory");
  syncProfileDirectory(parent);
}

function parseJournal(value: unknown): ProfileRecoveryJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Profile Recovery journal is malformed.");
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, [
    "backupManifestSha256", "createdAt", "expectedGeneration", "kind", "operation", "operationId",
    "phase", "profileId", "schemaVersion", "tombstoneName", "updatedAt",
  ])
    || record.schemaVersion !== PROFILE_OPERATION_RECOVERY_SCHEMA_VERSION
    || record.kind !== "rangabot-profile-operation-recovery"
    || !canonicalUuid(record.operationId)
    || !canonicalUuid(record.profileId)
    || !["default-migration", "create", "restore", "reset", "delete"].includes(String(record.operation))
    || !["prepared", "profile-root-created", "profile-root-restored", "tombstone-moved", "replacement-created", "registry-committed"].includes(String(record.phase))
    || !Number.isSafeInteger(record.expectedGeneration) || Number(record.expectedGeneration) < 0
    || (record.tombstoneName !== null && (typeof record.tombstoneName !== "string"
      || !/^(?:reset|delete)-[0-9a-f-]{36}-[0-9a-f-]{36}$/.test(record.tombstoneName)))
    || (record.backupManifestSha256 !== null && (typeof record.backupManifestSha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(record.backupManifestSha256)))
    || !canonicalTimestamp(record.createdAt) || !canonicalTimestamp(record.updatedAt)
    || Date.parse(String(record.updatedAt)) < Date.parse(String(record.createdAt))) {
    throw new Error("Profile Recovery journal has an invalid or unrecognized schema.");
  }
  const operation = record.operation as ProfileRecoveryOperation;
  const phase = record.phase as ProfileRecoveryPhase;
  const expectedTombstone = operation === "reset" || operation === "delete"
    ? `${operation}-${String(record.profileId)}-${String(record.operationId)}`
    : null;
  if ((operation === "restore") !== (record.backupManifestSha256 !== null)
    || record.tombstoneName !== expectedTombstone
    || (operation === "default-migration" && record.expectedGeneration !== 0)
    || (operation !== "default-migration" && Number(record.expectedGeneration) < 1)
    || (operation === "create" && !["prepared", "profile-root-created", "registry-committed"].includes(phase))
    || (operation === "restore" && !["prepared", "profile-root-restored", "registry-committed"].includes(phase))
    || ((operation === "reset" || operation === "delete")
      && !["prepared", "tombstone-moved", "replacement-created", "registry-committed"].includes(phase))) {
    throw new Error("Profile Recovery journal operation and phase do not match.");
  }
  return Object.freeze(record as unknown as ProfileRecoveryJournal);
}

function writeJournal(path: string, journal: ProfileRecoveryJournal, root: string) {
  const content = `${JSON.stringify(journal, null, 2)}\n`;
  if (Buffer.byteLength(content, "utf8") > journalMaximumBytes) throw new Error("Profile Recovery journal exceeds its size limit.");
  const temporary = join(dirname(path), `.operation-recovery-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
      | (posixGuards ? constants.O_NOFOLLOW : 0), privateFileMode);
    if (posixGuards) fchmodSync(descriptor, privateFileMode);
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    const written = fstatSync(descriptor);
    if (!written.isFile() || written.nlink !== 1 || written.size !== Buffer.byteLength(content, "utf8")) {
      throw new Error("Profile Recovery temporary journal is unsafe.");
    }
    closeSync(descriptor);
    descriptor = undefined;
    try { assertOwnedPrivateFile(path, "Profile Recovery journal"); }
    catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
    renameSync(temporary, path);
    assertOwnedPrivateFile(path, "Profile Recovery journal");
    syncProfileDirectory(root);
  } catch (error) {
    if (descriptor !== undefined) try { closeSync(descriptor); } catch { /* preserve */ }
    try { unlinkSync(temporary); } catch { /* preserve */ }
    throw error;
  }
}

export function readProfileRecoveryJournal(managedRoot: string): ProfileRecoveryJournal | null {
  const paths = layout(managedRoot);
  try {
    assertOwnedPrivateDirectory(paths.managedRoot, "Profile managed root");
    assertOwnedPrivateDirectory(paths.registryRoot, "Profile registry root");
    assertOwnedPrivateFile(paths.journalPath, "Profile Recovery journal");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  return parseJournal(JSON.parse(readFileSync(paths.journalPath, "utf8")) as unknown);
}

export function requireNoProfileRecovery(managedRoot: string) {
  const pending = readProfileRecoveryJournal(managedRoot);
  if (pending) {
    throw new Error(`Profile Recovery is required before ${pending.operation.replaceAll("-", " ")} can continue.`);
  }
}

export function beginProfileRecovery(input: {
  managedRoot: string;
  operation: ProfileRecoveryOperation;
  profileId: string;
  expectedGeneration: number;
  tombstoneName?: string;
  backupManifestSha256?: string;
  operationId?: string;
  now?: string;
}) {
  const paths = layout(input.managedRoot);
  assertOwnedPrivateDirectory(paths.managedRoot, "Profile managed root");
  try { mkdirSync(paths.registryRoot, { mode: privateDirectoryMode }); }
  catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
  if (posixGuards) chmodSync(paths.registryRoot, privateDirectoryMode);
  assertOwnedPrivateDirectory(paths.registryRoot, "Profile registry root");
  syncProfileDirectory(paths.managedRoot);
  if (readProfileRecoveryJournal(input.managedRoot)) throw new Error("Another Profile Recovery operation must be resolved first.");
  const timestamp = input.now ?? new Date().toISOString();
  const journal = parseJournal({
    schemaVersion: PROFILE_OPERATION_RECOVERY_SCHEMA_VERSION,
    kind: "rangabot-profile-operation-recovery",
    operationId: input.operationId ?? randomUUID(),
    operation: input.operation,
    phase: "prepared",
    profileId: input.profileId,
    expectedGeneration: input.expectedGeneration,
    tombstoneName: input.tombstoneName ?? null,
    backupManifestSha256: input.backupManifestSha256 ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  writeJournal(paths.journalPath, journal, paths.registryRoot);
  return Object.freeze({
    journal,
    paths,
    update(phase: ProfileRecoveryPhase) {
      return updateProfileRecovery(input.managedRoot, phase);
    },
  });
}

export function updateProfileRecovery(managedRoot: string, phase: ProfileRecoveryPhase, now?: string) {
  const paths = layout(managedRoot);
  const current = readProfileRecoveryJournal(managedRoot);
  if (!current) throw new Error("Profile Recovery journal is missing.");
  const candidateTimestamp = now ?? new Date().toISOString();
  if (!canonicalTimestamp(candidateTimestamp)) throw new Error("Profile Recovery requires a valid timestamp.");
  const updatedAt = Date.parse(candidateTimestamp) < Date.parse(current.updatedAt) ? current.updatedAt : candidateTimestamp;
  const next = parseJournal({ ...current, phase, updatedAt });
  writeJournal(paths.journalPath, next, paths.registryRoot);
  return next;
}

export function clearProfileRecovery(managedRoot: string) {
  const paths = layout(managedRoot);
  const current = readProfileRecoveryJournal(managedRoot);
  if (!current) return false;
  unlinkSync(paths.journalPath);
  syncProfileDirectory(paths.registryRoot);
  return true;
}

export function createProfileRecoveryJournalForTests(input: Parameters<typeof beginProfileRecovery>[0]) {
  return beginProfileRecovery(input);
}

export function profileRecoveryPaths(managedRoot: string, journal: ProfileRecoveryJournal) {
  const paths = layout(managedRoot);
  const profileRoot = join(paths.profilesRoot, journal.profileId);
  const tombstone = journal.tombstoneName ? join(paths.tombstonesRoot, journal.tombstoneName) : null;
  const migrationManifest = join(paths.recoveryRoot, `default-migration-${journal.profileId}.json`);
  const migrationStagePrefix = `.${journal.profileId}.migration-stage-`;
  const restoreStage = join(paths.profilesRoot, `.${journal.profileId}.restore-${journal.operationId}`);
  for (const candidate of [profileRoot, tombstone, migrationManifest, restoreStage].filter(Boolean) as string[]) {
    if (!pathInside(paths.managedRoot, candidate)) throw new Error("Profile Recovery target escaped its managed root.");
  }
  return Object.freeze({ ...paths, profileRoot, tombstone, migrationManifest, migrationStagePrefix, restoreStage });
}

export function ensureProfileRecoveryDirectory(path: string, parent: string) {
  ensurePrivateDirectory(path, parent);
}
