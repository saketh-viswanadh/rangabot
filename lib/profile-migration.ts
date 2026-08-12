import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { writePrivateJsonFileAtomic } from "./private-storage.ts";
import { validateProfileDomainRoot } from "./profile-domain-validation.ts";
import { syncProfileDirectory } from "./profile-recovery.ts";

export const PROFILE_MIGRATION_SCHEMA_VERSION = 1;

type MigrationFile = Readonly<{ path: string; bytes: number; sha256: string }>;

export type LegacyProfileInventory = Readonly<{
  schemaVersion: typeof PROFILE_MIGRATION_SCHEMA_VERSION;
  files: MigrationFile[];
  directories: string[];
  totalBytes: number;
  digest: string;
}>;

const managedExclusions = new Set([
  "profile-registry.json",
  "profile-registry.json.backup",
  "profile-registry.lock",
  "profiles",
  "profile-recovery",
  "profile-tombstones",
  "profiles-v1",
  "models",
  "tmp",
  "rangabot.db-runtime.lock",
]);

function inside(root: string, path: string) {
  const child = relative(root, path);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function byteSorted(left: string, right: string) {
  return Buffer.from(left).compare(Buffer.from(right));
}

function portablePathKey(value: string) {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function requireCanonicalDirectoryEntries(names: readonly string[]) {
  const keys = new Set<string>();
  for (const name of names) {
    if (!name || name !== name.normalize("NFC") || name === "." || name === ".."
      || name.length > 255 || !/^[\x20-\x7e]+$/.test(name)) {
      throw new Error("Profile migration path names must use bounded printable ASCII.");
    }
    const key = portablePathKey(name);
    if (keys.has(key)) throw new Error("Profile migration refuses case or Unicode-colliding paths.");
    keys.add(key);
  }
}

function canonicalInventory(files: MigrationFile[], directories: string[]) {
  return JSON.stringify({ files, directories });
}

function assertRoot(path: string) {
  const status = lstatSync(path, { bigint: true });
  if (status.isSymbolicLink() || !status.isDirectory()) throw new Error("Profile migration root must be a real directory.");
  if (process.platform !== "win32" && process.getuid && status.uid !== BigInt(process.getuid())) {
    throw new Error("Profile migration root must be owned by the current local user.");
  }
  if (process.platform !== "win32" && (status.mode & BigInt(0o077)) !== BigInt(0)) {
    throw new Error("Profile migration root must be owner-private.");
  }
}

function assertSafePathFromRoot(root: string, target: string) {
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(target);
  if (!inside(absoluteRoot, absoluteTarget)) throw new Error("Profile migration path escapes its managed root.");
  const components = relative(absoluteRoot, absoluteTarget).split(sep).filter(Boolean);
  let cursor = absoluteRoot;
  assertRoot(cursor);
  for (const component of components) {
    cursor = resolve(cursor, component);
    try {
      const status = lstatSync(cursor, { bigint: true });
      if (status.isSymbolicLink()) throw new Error("Profile migration refuses symbolic-link path components.");
      if (cursor !== absoluteTarget && !status.isDirectory()) {
        throw new Error("Profile migration path ancestor is not a directory.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export function inventoryLegacyProfileData(managedRoot: string): LegacyProfileInventory {
  const root = resolve(managedRoot);
  assertRoot(root);
  const files: MigrationFile[] = [];
  const directories: string[] = [];
  let totalBytes = 0;
  const visit = (directory: string) => {
    const entries = readdirSync(directory, { withFileTypes: true });
    requireCanonicalDirectoryEntries(entries.map(({ name }) => name));
    entries.sort((left, right) => byteSorted(left.name, right.name));
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      if (!inside(root, absolute)) throw new Error("Profile migration path escapes the managed root.");
      const path = relative(root, absolute).split(sep).join("/");
      if (managedExclusions.has(portablePathKey(path.split("/", 1)[0]))) continue;
      const status = lstatSync(absolute, { bigint: true });
      if (status.isSymbolicLink()) throw new Error("Profile migration refuses symbolic links.");
      if (status.isDirectory()) {
        directories.push(path);
        visit(absolute);
        continue;
      }
      if (!status.isFile() || status.nlink !== BigInt(1)) {
        throw new Error("Profile migration refuses non-regular or hard-linked entries.");
      }
      const bytes = readFileSync(absolute);
      const after = lstatSync(absolute, { bigint: true });
      if (after.dev !== status.dev || after.ino !== status.ino || after.size !== status.size
        || after.mtimeNs !== status.mtimeNs || after.ctimeNs !== status.ctimeNs) {
        throw new Error("Legacy data changed during migration preflight.");
      }
      totalBytes += bytes.byteLength;
      if (!Number.isSafeInteger(totalBytes)) throw new Error("Legacy data is too large to inventory safely.");
      files.push(Object.freeze({ path, bytes: bytes.byteLength, sha256: sha256(bytes) }));
    }
  };
  visit(root);
  files.sort((left, right) => byteSorted(left.path, right.path));
  directories.sort(byteSorted);
  return Object.freeze({
    schemaVersion: PROFILE_MIGRATION_SCHEMA_VERSION,
    files,
    directories,
    totalBytes,
    digest: sha256(canonicalInventory(files, directories)),
  });
}

function createPrivateDirectory(path: string) {
  mkdirSync(path, { mode: 0o700 });
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isDirectory()) throw new Error("Profile migration could not create a private directory.");
}

function copyVerifiedFile(source: string, target: string, expected: MigrationFile) {
  const sourceStatus = lstatSync(source, { bigint: true });
  if (sourceStatus.isSymbolicLink() || !sourceStatus.isFile() || sourceStatus.nlink !== BigInt(1)) {
    throw new Error("Legacy profile source changed before copy.");
  }
  const bytes = readFileSync(source);
  if (bytes.byteLength !== expected.bytes || sha256(bytes) !== expected.sha256) {
    throw new Error("Legacy profile source changed after preflight.");
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    fchmodSync(descriptor, 0o600);
    const copied = fstatSync(descriptor, { bigint: true });
    if (!copied.isFile() || copied.size !== BigInt(expected.bytes)) throw new Error("Profile migration copy is incomplete.");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  const targetBytes = readFileSync(target);
  if (targetBytes.byteLength !== expected.bytes || sha256(targetBytes) !== expected.sha256) {
    throw new Error("Profile migration copy failed integrity verification.");
  }
}

export type DefaultProfileMigrationReceipt = Readonly<{
  profileId: string;
  profileRoot: string;
  inventory: LegacyProfileInventory;
  recoveryManifestPath: string;
  originalRoot: string;
}>;

export function migrateLegacyDataToDefault(input: {
  managedRoot: string;
  profilesRoot: string;
  recoveryRoot: string;
  profileId?: string;
  activateRegistry: (profileId: string) => void;
  inventory?: (managedRoot: string) => LegacyProfileInventory;
  copyFile?: (source: string, target: string, expected: MigrationFile) => void;
  now?: string;
}): DefaultProfileMigrationReceipt {
  const managedRoot = resolve(input.managedRoot);
  const profilesRoot = resolve(input.profilesRoot);
  const recoveryRoot = resolve(input.recoveryRoot);
  if (!inside(managedRoot, profilesRoot) || !inside(managedRoot, recoveryRoot)) {
    throw new Error("Profile migration destinations must stay inside the managed root.");
  }
  assertRoot(managedRoot);
  assertSafePathFromRoot(managedRoot, profilesRoot);
  assertSafePathFromRoot(managedRoot, recoveryRoot);
  const profileId = input.profileId ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(profileId)) {
    throw new Error("Default profile identity is invalid.");
  }
  const now = input.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now) throw new Error("Migration time is invalid.");
  const inventory = (input.inventory ?? inventoryLegacyProfileData)(managedRoot);
  mkdirSync(profilesRoot, { recursive: true, mode: 0o700 });
  mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 });
  assertSafePathFromRoot(managedRoot, profilesRoot);
  assertSafePathFromRoot(managedRoot, recoveryRoot);
  assertRoot(profilesRoot);
  assertRoot(recoveryRoot);
  const finalRoot = resolve(profilesRoot, profileId);
  const stageRoot = resolve(profilesRoot, `.${profileId}.migration-stage-${randomUUID()}`);
  if (!inside(profilesRoot, finalRoot) || !inside(profilesRoot, stageRoot)) throw new Error("Profile migration target escapes the profile container.");
  for (const path of [finalRoot, stageRoot]) {
    try { lstatSync(path); throw new Error("Default profile migration target already exists."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const recoveryManifestPath = resolve(recoveryRoot, `default-migration-${profileId}.json`);
  const copyFile = input.copyFile ?? copyVerifiedFile;
  let activationMayHaveCommitted = false;
  try {
    createPrivateDirectory(stageRoot);
    for (const directory of inventory.directories) {
      const destination = resolve(stageRoot, ...directory.split("/"));
      if (!inside(stageRoot, destination)) throw new Error("Profile migration directory escapes staging.");
      mkdirSync(destination, { recursive: true, mode: 0o700 });
    }
    for (const file of inventory.files) {
      const source = resolve(managedRoot, ...file.path.split("/"));
      const destination = resolve(stageRoot, ...file.path.split("/"));
      if (!inside(managedRoot, source) || !inside(stageRoot, destination)) throw new Error("Profile migration file escapes staging.");
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      copyFile(source, destination, file);
    }
    const staged = inventoryLegacyProfileData(stageRoot);
    if (staged.digest !== inventory.digest || staged.totalBytes !== inventory.totalBytes) {
      throw new Error("Staged Default profile did not match the verified legacy inventory.");
    }
    validateProfileDomainRoot(stageRoot);
    writePrivateJsonFileAtomic(recoveryManifestPath, {
      schemaVersion: PROFILE_MIGRATION_SCHEMA_VERSION,
      kind: "rangabot-default-profile-recovery-point",
      profileId,
      originalRoot: basename(managedRoot),
      originalDataRetained: true,
      createdAt: now,
      inventory,
    }, { trustedRoot: managedRoot });
    renameSync(stageRoot, finalRoot);
    syncProfileDirectory(profilesRoot);
    // Activation can durably publish the registry and still throw while
    // releasing its lock or reporting the result. From this boundary onward,
    // only sealed Recovery may decide whether the final root is committed or
    // orphaned; deleting it here could erase an already-active Default.
    activationMayHaveCommitted = true;
    input.activateRegistry(profileId);
    return Object.freeze({ profileId, profileRoot: finalRoot, inventory, recoveryManifestPath, originalRoot: managedRoot });
  } catch (error) {
    if (!activationMayHaveCommitted) {
      for (const path of [stageRoot, finalRoot]) {
        try {
          if (inside(profilesRoot, path) && lstatSync(path).isDirectory()) {
            rmSync(path, { recursive: true });
            syncProfileDirectory(profilesRoot);
          }
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
            throw new AggregateError([error, cleanupError], "Profiles could not be set up and the unused staged copy needs manual recovery.");
          }
        }
      }
    }
    throw error;
  }
}
