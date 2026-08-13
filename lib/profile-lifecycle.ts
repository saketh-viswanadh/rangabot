import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync as Database } from "node:sqlite";
import { closeConversationDatabase } from "./conversations.ts";
import { closeKnowledgeDatabase } from "./knowledge.ts";
import { closeMemoryDatabase } from "./memories.ts";
import {
  createProfileBackup,
  inspectProfileBackup,
  readProfileRestoreOriginMarker,
  restoreProfileBackup,
} from "./profile-backup.ts";
import { getProfileRegistry } from "./profile-context.ts";
import { validateProfileDomainRoot } from "./profile-domain-validation.ts";
import { inventoryLegacyProfileData, migrateLegacyDataToDefault } from "./profile-migration.ts";
import { profileOperations, withProfileOperation, type ActiveProfileOperation } from "./profile-operations.ts";
import {
  beginProfileRecovery,
  clearProfileRecovery,
  profileRecoveryPaths,
  readProfileRecoveryJournal,
  requireNoProfileRecovery,
  syncProfileDirectory,
  updateProfileRecovery,
  type ProfileRecoveryJournal,
} from "./profile-recovery.ts";
import {
  PROFILE_DATA_DIRECTORY_NAME,
  PROFILE_REGISTRY_DIRECTORY_NAME,
  type CreatableProfileKind,
  type ProfileMetadata,
  type ProfileRegistrySnapshot,
} from "./profile-registry.ts";
import { runtimeManagedDataPath, runtimePaths } from "./runtime-paths.ts";

const serverRequire = createRequire(runtimePaths.packageJson);
const { DatabaseSync } = serverRequire("node:sqlite") as typeof import("node:sqlite");

export class ProfileBusyError extends Error {
  readonly operation: ActiveProfileOperation;
  constructor(operation: ActiveProfileOperation, activeProfileName: string) {
    super(`Can’t switch profiles while ${operation.label} is active. Wait for it to finish${operation.cancellable ? ", cancel it safely" : ""}, or stay in ${activeProfileName}.`);
    this.name = "ProfileBusyError";
    this.operation = operation;
  }
}

export class ProfileLifecycleError extends Error {
  readonly code: "setup-required" | "invalid" | "not-found" | "protected" | "conflict" | "recovery-required";
  constructor(code: ProfileLifecycleError["code"], message: string) {
    super(message);
    this.name = "ProfileLifecycleError";
    this.code = code;
  }
}

function inside(root: string, candidate: string) {
  const child = relative(root, candidate);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

function requirePrivateDirectory(path: string, container: string) {
  const absolute = resolve(path);
  if (!inside(resolve(container), absolute)) throw new ProfileLifecycleError("invalid", "The profile root escaped its private container.");
  const status = lstatSync(absolute);
  if (status.isSymbolicLink() || !status.isDirectory()) throw new ProfileLifecycleError("invalid", "The profile root is not a real local directory.");
  if (process.platform !== "win32" && process.getuid && status.uid !== process.getuid()) {
    throw new ProfileLifecycleError("invalid", "The profile root is not owned by the current local user.");
  }
  if (process.platform !== "win32" && (status.mode & 0o077) !== 0) {
    throw new ProfileLifecycleError("invalid", "The profile root is not owner-private.");
  }
  return absolute;
}

function currentSnapshot() {
  const registry = getProfileRegistry();
  const snapshot = registry.read();
  if (!snapshot) throw new ProfileLifecycleError("setup-required", "Profiles have not been set up yet.");
  return { registry, snapshot };
}

function missing(path: string) {
  try { lstatSync(path); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
}

function requirePrivateRegularFile(path: string, container: string, label: string) {
  const absolute = resolve(path);
  if (!inside(resolve(container), absolute)) throw new ProfileLifecycleError("invalid", `${label} escaped its private container.`);
  const status = lstatSync(absolute);
  if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1) {
    throw new ProfileLifecycleError("invalid", `${label} is not a non-linked regular file.`);
  }
  if (process.platform !== "win32" && process.getuid && (status.uid !== process.getuid() || (status.mode & 0o077) !== 0)) {
    throw new ProfileLifecycleError("invalid", `${label} is not owner-private.`);
  }
  return absolute;
}

function validateSqliteFamily(databasePath: string, profileRoot: string) {
  if (missing(databasePath)) return false;
  requirePrivateRegularFile(databasePath, profileRoot, "Profile database");
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = `${databasePath}${suffix}`;
    if (!missing(sidecar)) requirePrivateRegularFile(sidecar, profileRoot, "Profile database sidecar");
  }
  return true;
}

function profileDatabasePaths(profileRoot: string) {
  return [
    join(profileRoot, "rangabot.db"),
    join(profileRoot, "rangabot-memory.db"),
    join(profileRoot, "knowledge", "indexes", "knowledge.db"),
  ] as const;
}

function profileHasPendingConversationTurn(profileRoot: string) {
  const path = join(profileRoot, "rangabot.db");
  if (!validateSqliteFamily(path, profileRoot)) return false;
  let database: Database | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    const table = database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'conversation_turns' LIMIT 1").get() as { present?: number } | undefined;
    if (!table) return false;
    const pending = database.prepare("SELECT 1 AS pending FROM conversation_turns WHERE status = 'pending' LIMIT 1").get() as { pending?: number } | undefined;
    return pending?.pending === 1;
  } finally {
    database?.close();
  }
}

function requireNoPendingConversationTurns(snapshot: ProfileRegistrySnapshot) {
  const registry = getProfileRegistry();
  for (const profile of snapshot.profiles) {
    const root = requirePrivateDirectory(registry.profileRoot(profile.id), registry.layout.profilesRoot);
    if (profileHasPendingConversationTurn(root)) {
      throw new ProfileLifecycleError(
        "conflict",
        `Can’t change profiles while a conversation turn remains pending in ${profile.displayName}. Finish or cancel it safely first.`,
      );
    }
  }
}

function requireMutationReady(snapshot?: ProfileRegistrySnapshot) {
  requireNoProfileRecovery(runtimePaths.managedDataRoot);
  const inspection = getProfileRegistry().inspect();
  if (inspection.kind === "ready" && inspection.source === "recovery") {
    throw new ProfileLifecycleError("recovery-required", "Profile registry Recovery is required before another profile change can be made.");
  }
  requireNoActiveOperations(snapshot);
  if (snapshot) requireNoPendingConversationTurns(snapshot);
  else if (profileHasPendingConversationTurn(runtimePaths.managedDataRoot)) {
    throw new ProfileLifecycleError("conflict", "Can’t set up profiles while a conversation turn remains pending. Finish or cancel it safely first.");
  }
}

function checkpointClosedProfileDatabases(profileRoot: string) {
  closeActiveProfileResources();
  for (const path of profileDatabasePaths(profileRoot)) {
    if (!validateSqliteFamily(path, profileRoot)) continue;
    let database: Database | undefined;
    try {
      database = new DatabaseSync(path);
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      database?.close();
    }
    validateSqliteFamily(path, profileRoot);
  }
}

function profileById(snapshot: ProfileRegistrySnapshot, profileId: string) {
  const profile = snapshot.profiles.find((candidate) => candidate.id === profileId);
  if (!profile) throw new ProfileLifecycleError("not-found", "That local profile does not exist.");
  return profile;
}

function activeProfileName(snapshot: ProfileRegistrySnapshot) {
  return profileById(snapshot, snapshot.activeProfileId).displayName;
}

function requireNoActiveOperations(snapshot?: ProfileRegistrySnapshot) {
  const blocker = profileOperations.firstBlocker();
  if (blocker) throw new ProfileBusyError(blocker, snapshot ? activeProfileName(snapshot) : "this profile");
}

export function closeActiveProfileResources() {
  closeConversationDatabase();
  closeMemoryDatabase();
  closeKnowledgeDatabase();
}

function createEmptyProfileRoot(profileId: string) {
  const registry = getProfileRegistry();
  const root = registry.profileRoot(profileId);
  const profilesRoot = runtimeManagedDataPath(PROFILE_REGISTRY_DIRECTORY_NAME, PROFILE_DATA_DIRECTORY_NAME);
  if (resolve(profilesRoot) !== resolve(registry.layout.profilesRoot)) {
    throw new ProfileLifecycleError("invalid", "The private profile container does not match its registry.");
  }
  mkdirSync(profilesRoot, { recursive: true, mode: 0o700 });
  requirePrivateDirectory(
    runtimeManagedDataPath(PROFILE_REGISTRY_DIRECTORY_NAME, PROFILE_DATA_DIRECTORY_NAME),
    runtimePaths.managedDataRoot,
  );
  try { lstatSync(root); throw new ProfileLifecycleError("conflict", "That profile storage already exists."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  mkdirSync(root, { mode: 0o700 });
  return requirePrivateDirectory(root, registry.layout.profilesRoot);
}

function validatePrivateTree(root: string, container: string, options: { empty?: boolean } = {}) {
  const safeRoot = requirePrivateDirectory(root, container);
  const seenPortable = new Set<string>();
  let entries = 0;
  let sizeBytes = 0;
  const visit = (directory: string) => {
    const children = readdirSync(directory, { withFileTypes: true });
    const localNames = new Set<string>();
    for (const child of children) {
      if (!child.name || child.name !== child.name.normalize("NFC")) {
        throw new ProfileLifecycleError("invalid", "Profile Recovery found a non-canonical path name.");
      }
      const localKey = child.name.toLocaleLowerCase("en-US");
      if (localNames.has(localKey)) throw new ProfileLifecycleError("invalid", "Profile Recovery found colliding path names.");
      localNames.add(localKey);
      const absolute = resolve(directory, child.name);
      if (!inside(safeRoot, absolute)) throw new ProfileLifecycleError("invalid", "Profile Recovery path escaped its profile root.");
      const relativePath = relative(safeRoot, absolute).split(sep).join("/");
      const portableKey = relativePath.normalize("NFC").toLocaleLowerCase("en-US");
      if (seenPortable.has(portableKey)) throw new ProfileLifecycleError("invalid", "Profile Recovery found colliding profile paths.");
      seenPortable.add(portableKey);
      const status = lstatSync(absolute);
      if (status.isSymbolicLink()) throw new ProfileLifecycleError("invalid", "Profile Recovery refuses symbolic links.");
      if (process.platform !== "win32" && process.getuid && status.uid !== process.getuid()) {
        throw new ProfileLifecycleError("invalid", "Profile Recovery found data owned by another user.");
      }
      entries += 1;
      if (status.isDirectory()) {
        if (process.platform !== "win32" && (status.mode & 0o077) !== 0) {
          throw new ProfileLifecycleError("invalid", "Profile Recovery found a non-private directory.");
        }
        visit(absolute);
      } else if (!status.isFile() || status.nlink !== 1) {
        throw new ProfileLifecycleError("invalid", "Profile Recovery refuses non-regular or hard-linked entries.");
      } else if (process.platform !== "win32" && (status.mode & 0o077) !== 0) {
        throw new ProfileLifecycleError("invalid", "Profile Recovery found a non-private file.");
      } else sizeBytes += status.size;
    }
  };
  visit(safeRoot);
  if (options.empty && entries !== 0) throw new ProfileLifecycleError("invalid", "Profile Recovery will only discard an empty app-created profile.");
  return Object.freeze({ root: safeRoot, entries, sizeBytes });
}

function safeRemovePrivateTree(root: string, container: string, options: { empty?: boolean } = {}) {
  const validated = validatePrivateTree(root, container, options);
  rmSync(validated.root, { recursive: true });
  syncProfileDirectory(container);
  if (!missing(validated.root)) throw new ProfileLifecycleError("conflict", "Private profile storage could not be fully removed.");
}

function readMigrationRecoveryManifest(path: string, managedRoot: string, profileId: string) {
  const safe = requirePrivateRegularFile(path, managedRoot, "Default migration recovery manifest");
  const status = lstatSync(safe);
  if (status.size > 16 * 1024 * 1024) throw new ProfileLifecycleError("invalid", "Default migration recovery manifest is too large.");
  const parsed = JSON.parse(readFileSync(safe, "utf8")) as Record<string, unknown>;
  if (!parsed || Object.keys(parsed).sort().join(",") !== ["createdAt", "inventory", "kind", "originalDataRetained", "originalRoot", "profileId", "schemaVersion"].sort().join(",")
    || parsed.schemaVersion !== 1 || parsed.kind !== "rangabot-default-profile-recovery-point"
    || parsed.profileId !== profileId || parsed.originalRoot !== basename(resolve(managedRoot))
    || parsed.originalDataRetained !== true || typeof parsed.createdAt !== "string"
    || !Number.isFinite(Date.parse(parsed.createdAt))) {
    throw new ProfileLifecycleError("invalid", "Default migration recovery manifest is invalid.");
  }
  const inventory = parsed.inventory as ReturnType<typeof inventoryLegacyProfileData>;
  if (!inventory || inventory.schemaVersion !== 1 || !Array.isArray(inventory.files) || !Array.isArray(inventory.directories)
    || !Number.isSafeInteger(inventory.totalBytes) || typeof inventory.digest !== "string" || !/^[0-9a-f]{64}$/.test(inventory.digest)) {
    throw new ProfileLifecycleError("invalid", "Default migration recovery inventory is invalid.");
  }
  return inventory;
}

function migrationInventoryFromRoot(root: string) {
  return inventoryLegacyProfileData(root);
}

function sameMigrationInventory(left: ReturnType<typeof inventoryLegacyProfileData>, right: ReturnType<typeof inventoryLegacyProfileData>) {
  return left.digest === right.digest && left.totalBytes === right.totalBytes
    && left.files.length === right.files.length && left.directories.length === right.directories.length;
}

function findMigrationStages(paths: ReturnType<typeof profileRecoveryPaths>) {
  let entries;
  try { entries = readdirSync(paths.profilesRoot, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[]; throw error; }
  const matches = entries.filter(({ name }) => name.startsWith(paths.migrationStagePrefix));
  if (matches.some((entry) => entry.isSymbolicLink() || !entry.isDirectory()) || matches.length > 1) {
    throw new ProfileLifecycleError("invalid", "Default migration Recovery found an unsafe or ambiguous staging root.");
  }
  return matches.map(({ name }) => resolve(paths.profilesRoot, name));
}

function registryContainsProfile(snapshot: ProfileRegistrySnapshot | null, profileId: string) {
  return snapshot?.profiles.some((profile) => profile.id === profileId) === true;
}

function recoverDefaultMigration(journal: ProfileRecoveryJournal) {
  const registry = getProfileRegistry();
  const paths = profileRecoveryPaths(runtimePaths.managedDataRoot, journal);
  const snapshot = registry.read();
  const stages = findMigrationStages(paths);
  const rootExists = !missing(paths.profileRoot);
  const manifestExists = !missing(paths.migrationManifest);
  if (registryContainsProfile(snapshot, journal.profileId)) {
    if (!rootExists || !manifestExists) throw new ProfileLifecycleError("invalid", "Committed Default profile Recovery evidence is incomplete.");
    const expected = readMigrationRecoveryManifest(paths.migrationManifest, paths.managedRoot, journal.profileId);
    if (!sameMigrationInventory(expected, migrationInventoryFromRoot(paths.profileRoot)) || stages.length) {
      throw new ProfileLifecycleError("invalid", "Committed Default profile Recovery evidence does not match.");
    }
    validateProfileDomainRoot(paths.profileRoot);
    clearProfileRecovery(paths.managedRoot);
    return "finalized" as const;
  }
  if (snapshot) throw new ProfileLifecycleError("conflict", "Default migration Recovery conflicts with an existing profile registry.");
  if (!manifestExists) {
    if (rootExists) throw new ProfileLifecycleError("invalid", "An unbound Default profile root cannot be recovered.");
    for (const stage of stages) safeRemovePrivateTree(stage, paths.profilesRoot);
    clearProfileRecovery(paths.managedRoot);
    return "rolled-back" as const;
  }
  const expected = readMigrationRecoveryManifest(paths.migrationManifest, paths.managedRoot, journal.profileId);
  const original = inventoryLegacyProfileData(paths.managedRoot);
  if (!sameMigrationInventory(expected, original)) {
    throw new ProfileLifecycleError("invalid", "Original legacy data changed after Default migration interruption.");
  }
  let candidate = rootExists ? paths.profileRoot : stages[0];
  if (!candidate || (rootExists && stages.length)) throw new ProfileLifecycleError("invalid", "Default migration Recovery evidence is incomplete or ambiguous.");
  if (!sameMigrationInventory(expected, migrationInventoryFromRoot(candidate))) {
    throw new ProfileLifecycleError("invalid", "Default migration Recovery copy failed its inventory check.");
  }
  validateProfileDomainRoot(candidate);
  if (candidate !== paths.profileRoot) {
    renameSync(candidate, paths.profileRoot);
    syncProfileDirectory(paths.profilesRoot);
    candidate = paths.profileRoot;
  }
  registry.initializeDefault({ profileId: journal.profileId, displayName: "Default" });
  updateProfileRecovery(paths.managedRoot, "registry-committed");
  clearProfileRecovery(paths.managedRoot);
  return "resumed" as const;
}

function validateRestoreMarker(root: string, journal: ProfileRecoveryJournal) {
  const marker = readProfileRestoreOriginMarker(root);
  if (marker.operationId !== journal.operationId || marker.profileId !== journal.profileId
    || marker.backupManifestSha256 !== journal.backupManifestSha256) {
    throw new ProfileLifecycleError("invalid", "Profile restore Recovery identity does not match its journal.");
  }
  validatePrivateTree(root, dirname(root));
  return marker;
}

function recoverCreateOrRestore(journal: ProfileRecoveryJournal) {
  const registry = getProfileRegistry();
  const paths = profileRecoveryPaths(runtimePaths.managedDataRoot, journal);
  const snapshot = registry.read();
  const registered = registryContainsProfile(snapshot, journal.profileId);
  const rootExists = !missing(paths.profileRoot);
  const stageExists = !missing(paths.restoreStage);
  if (journal.operation === "create") {
    if (stageExists) throw new ProfileLifecycleError("invalid", "Create Recovery found an unexpected restore stage.");
    if (registered) {
      if (!rootExists) throw new ProfileLifecycleError("invalid", "Registered profile storage is missing during Recovery.");
      requirePrivateDirectory(paths.profileRoot, paths.profilesRoot);
      clearProfileRecovery(paths.managedRoot);
      return "finalized" as const;
    }
    if (snapshot && snapshot.generation !== journal.expectedGeneration) {
      throw new ProfileLifecycleError("conflict", "Profile registry changed after interrupted creation.");
    }
    if (rootExists) safeRemovePrivateTree(paths.profileRoot, paths.profilesRoot, { empty: true });
    clearProfileRecovery(paths.managedRoot);
    return "rolled-back" as const;
  }
  if (rootExists && stageExists) throw new ProfileLifecycleError("invalid", "Restore Recovery found ambiguous roots.");
  const candidate = rootExists ? paths.profileRoot : stageExists ? paths.restoreStage : null;
  if (registered) {
    if (!rootExists || stageExists) throw new ProfileLifecycleError("invalid", "Registered restored profile storage is incomplete.");
    validateRestoreMarker(paths.profileRoot, journal);
    // Keep the content-minimized origin seal with the restored profile. It is
    // excluded from future backups and lets Recovery prove the committed root
    // across every crash boundary, including after registry publication.
    clearProfileRecovery(paths.managedRoot);
    return "finalized" as const;
  }
  if (snapshot && snapshot.generation !== journal.expectedGeneration) {
    throw new ProfileLifecycleError("conflict", "Profile registry changed after interrupted restore.");
  }
  if (candidate) {
    validateRestoreMarker(candidate, journal);
    safeRemovePrivateTree(candidate, paths.profilesRoot);
  }
  clearProfileRecovery(paths.managedRoot);
  return "rolled-back" as const;
}

function recoverTombstone(journal: ProfileRecoveryJournal) {
  const registry = getProfileRegistry();
  const paths = profileRecoveryPaths(runtimePaths.managedDataRoot, journal);
  const snapshot = registry.read();
  if (!snapshot || !paths.tombstone) throw new ProfileLifecycleError("invalid", "Tombstone Recovery has no valid registry context.");
  const registered = registryContainsProfile(snapshot, journal.profileId);
  const committed = snapshot.generation === journal.expectedGeneration + 1
    && (journal.operation === "reset" ? registered : !registered);
  const uncommitted = snapshot.generation === journal.expectedGeneration && registered;
  if (!committed && !uncommitted) throw new ProfileLifecycleError("conflict", "Profile registry does not match the interrupted destructive operation.");
  const rootExists = !missing(paths.profileRoot);
  const tombstoneExists = !missing(paths.tombstone);
  if (committed) {
    if (!tombstoneExists) {
      if (journal.operation === "reset" && !rootExists) throw new ProfileLifecycleError("invalid", "Committed reset replacement is missing.");
      clearProfileRecovery(paths.managedRoot);
      return "finalized" as const;
    }
    if (journal.operation === "reset") validatePrivateTree(paths.profileRoot, paths.profilesRoot, { empty: true });
    validatePrivateTree(paths.tombstone, paths.tombstonesRoot);
    safeRemovePrivateTree(paths.tombstone, paths.tombstonesRoot);
    clearProfileRecovery(paths.managedRoot);
    return "finalized" as const;
  }
  if (!tombstoneExists) {
    if (!rootExists || journal.phase !== "prepared") throw new ProfileLifecycleError("invalid", "Uncommitted profile tombstone is missing.");
    clearProfileRecovery(paths.managedRoot);
    return "rolled-back" as const;
  }
  validatePrivateTree(paths.tombstone, paths.tombstonesRoot);
  if (rootExists) {
    if (journal.operation !== "reset") throw new ProfileLifecycleError("invalid", "Delete Recovery found an unexpected replacement root.");
    safeRemovePrivateTree(paths.profileRoot, paths.profilesRoot, { empty: true });
  }
  renameSync(paths.tombstone, paths.profileRoot);
  syncProfileDirectory(paths.tombstonesRoot);
  syncProfileDirectory(paths.profilesRoot);
  clearProfileRecovery(paths.managedRoot);
  return "rolled-back" as const;
}

export function recoverProfileLifecycle(input: { confirmed: true; expectedGeneration: number }) {
  if (input.confirmed !== true || !Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0) {
    throw new ProfileLifecycleError("invalid", "Explicit profile Recovery confirmation is required.");
  }
  requireNoActiveOperations();
  const registry = getProfileRegistry();
  const inspection = registry.inspect();
  if (inspection.kind === "ready" && inspection.source === "recovery") {
    if (inspection.snapshot.generation !== input.expectedGeneration) {
      throw new ProfileLifecycleError("conflict", "Profile registry changed before Recovery confirmation.");
    }
    registry.recover({ expectedGeneration: input.expectedGeneration });
  }
  const journal = readProfileRecoveryJournal(runtimePaths.managedDataRoot);
  if (!journal) return Object.freeze({ resolution: "registry-only" as const });
  const current = registry.read();
  if (journal.operation !== "default-migration") {
    // The registry and the operation journal are separate durable writes. A
    // crash can therefore leave a sealed journal phase behind even though the
    // registry mutation committed. Admit only the two exact states the sealed
    // operation can produce, then let its operation-specific recovery prove
    // which state is valid before changing either root.
    const eligibleGenerations = new Set([journal.expectedGeneration, journal.expectedGeneration + 1]);
    if (current?.generation !== input.expectedGeneration || !eligibleGenerations.has(input.expectedGeneration)) {
      throw new ProfileLifecycleError("conflict", "Profile registry changed before operation Recovery confirmation.");
    }
  }
  closeActiveProfileResources();
  const resolution = journal.operation === "default-migration"
    ? recoverDefaultMigration(journal)
    : journal.operation === "create" || journal.operation === "restore"
      ? recoverCreateOrRestore(journal)
      : recoverTombstone(journal);
  return Object.freeze({ resolution, operation: journal.operation });
}

export function initializeDefaultProfile(input: { confirmed: true; displayName?: string }) {
  if (input.confirmed !== true) throw new ProfileLifecycleError("invalid", "Default profile setup requires explicit confirmation.");
  const registry = getProfileRegistry();
  if (registry.read()) throw new ProfileLifecycleError("conflict", "Profiles are already set up.");
  requireMutationReady();
  closeActiveProfileResources();
  const profileId = registry.allocateProfileId();
  beginProfileRecovery({
    managedRoot: runtimePaths.managedDataRoot,
    operation: "default-migration",
    profileId,
    expectedGeneration: 0,
  });
  try {
    const receipt = migrateLegacyDataToDefault({
      managedRoot: runtimePaths.managedDataRoot,
      profilesRoot: registry.layout.profilesRoot,
      recoveryRoot: runtimePaths.profileRecoveryRoot,
      profileId,
      activateRegistry(defaultProfileId) {
        updateProfileRecovery(runtimePaths.managedDataRoot, "profile-root-restored");
        registry.initializeDefault({ profileId: defaultProfileId, displayName: input.displayName ?? "Default" });
      },
    });
    updateProfileRecovery(runtimePaths.managedDataRoot, "registry-committed");
    const snapshot = registry.read();
    if (!snapshot) throw new Error("The Default profile registry did not persist.");
    clearProfileRecovery(runtimePaths.managedDataRoot);
    return Object.freeze({
      snapshot,
      receipt,
      message: "Your existing workspace is ready in Default.",
    });
  } catch (error) {
    throw new ProfileLifecycleError(
      "recovery-required",
      "Profiles could not be set up. Your original RangaBot data was not replaced. You can retry or continue with the previous setup.",
    );
  }
}

export function createProfile(input: { displayName: string; kind: CreatableProfileKind; expectedGeneration: number }) {
  const { registry, snapshot } = currentSnapshot();
  requireMutationReady(snapshot);
  const profileId = registry.allocateProfileId();
  beginProfileRecovery({
    managedRoot: runtimePaths.managedDataRoot,
    operation: "create",
    profileId,
    expectedGeneration: input.expectedGeneration,
  });
  createEmptyProfileRoot(profileId);
  syncProfileDirectory(registry.layout.profilesRoot);
  updateProfileRecovery(runtimePaths.managedDataRoot, "profile-root-created");
  const next = registry.create({ ...input, profileId });
  updateProfileRecovery(runtimePaths.managedDataRoot, "registry-committed");
  clearProfileRecovery(runtimePaths.managedDataRoot);
  return Object.freeze({ snapshot: next, profile: profileById(next, profileId) });
}

export function renameProfile(input: { profileId: string; displayName: string; expectedGeneration: number }) {
  const { registry, snapshot } = currentSnapshot();
  requireMutationReady(snapshot);
  return registry.rename(input);
}

export function switchProfile(input: { profileId: string; expectedGeneration: number }) {
  const { registry, snapshot } = currentSnapshot();
  requireMutationReady(snapshot);
  const target = profileById(snapshot, input.profileId);
  const targetRoot = requirePrivateDirectory(registry.profileRoot(target.id), registry.layout.profilesRoot);
  validateProfileDomainRoot(targetRoot);
  closeActiveProfileResources();
  const next = registry.switchActive(input);
  return Object.freeze({ snapshot: next, profile: profileById(next, next.activeProfileId) });
}

function tombstonePath(profile: ProfileMetadata, operation: "reset" | "delete", operationId: string) {
  const requestedRoot = runtimeManagedDataPath(PROFILE_REGISTRY_DIRECTORY_NAME, "tombstones");
  mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
  const root = requirePrivateDirectory(
    runtimeManagedDataPath(PROFILE_REGISTRY_DIRECTORY_NAME, "tombstones"),
    runtimeManagedDataPath(PROFILE_REGISTRY_DIRECTORY_NAME),
  );
  syncProfileDirectory(runtimeManagedDataPath(PROFILE_REGISTRY_DIRECTORY_NAME));
  const name = `${operation}-${profile.id}-${operationId}`;
  return Object.freeze({ root, name, path: resolve(root, name) });
}

export function resetTestingProfile(input: { profileId: string; expectedGeneration: number; confirmedName: string }) {
  const { registry, snapshot } = currentSnapshot();
  const profile = profileById(snapshot, input.profileId);
  if (profile.kind !== "testing") throw new ProfileLifecycleError("protected", "Only a Testing · Temporary profile can be reset.");
  if (profile.id === snapshot.activeProfileId) throw new ProfileLifecycleError("protected", "Switch away from the active profile before resetting it.");
  if (input.confirmedName !== profile.displayName) throw new ProfileLifecycleError("invalid", "Enter the exact profile name to reset it.");
  requireMutationReady(snapshot);
  const root = requirePrivateDirectory(registry.profileRoot(profile.id), registry.layout.profilesRoot);
  const operationId = randomUUID();
  const tombstone = tombstonePath(profile, "reset", operationId);
  beginProfileRecovery({
    managedRoot: runtimePaths.managedDataRoot,
    operation: "reset",
    profileId: profile.id,
    expectedGeneration: input.expectedGeneration,
    tombstoneName: tombstone.name,
    operationId,
  });
  renameSync(root, tombstone.path);
  syncProfileDirectory(registry.layout.profilesRoot);
  syncProfileDirectory(tombstone.root);
  updateProfileRecovery(runtimePaths.managedDataRoot, "tombstone-moved");
  mkdirSync(root, { mode: 0o700 });
  syncProfileDirectory(registry.layout.profilesRoot);
  updateProfileRecovery(runtimePaths.managedDataRoot, "replacement-created");
  const next = registry.bump({ expectedGeneration: input.expectedGeneration });
  updateProfileRecovery(runtimePaths.managedDataRoot, "registry-committed");
  let cleanupPending = false;
  try {
    safeRemovePrivateTree(tombstone.path, tombstone.root);
    clearProfileRecovery(runtimePaths.managedDataRoot);
  } catch { cleanupPending = true; }
  return Object.freeze({ snapshot: next, cleanupPending });
}

export function deleteProfile(input: { profileId: string; expectedGeneration: number; confirmedName: string }) {
  const { registry, snapshot } = currentSnapshot();
  const profile = profileById(snapshot, input.profileId);
  if (profile.protected) throw new ProfileLifecycleError("protected", "The protected Default profile cannot be deleted.");
  if (profile.id === snapshot.activeProfileId) throw new ProfileLifecycleError("protected", "The active profile cannot be deleted.");
  if (input.confirmedName !== profile.displayName) throw new ProfileLifecycleError("invalid", "Enter the exact profile name to delete it.");
  requireMutationReady(snapshot);
  const root = requirePrivateDirectory(registry.profileRoot(profile.id), registry.layout.profilesRoot);
  const operationId = randomUUID();
  const tombstone = tombstonePath(profile, "delete", operationId);
  beginProfileRecovery({
    managedRoot: runtimePaths.managedDataRoot,
    operation: "delete",
    profileId: profile.id,
    expectedGeneration: input.expectedGeneration,
    tombstoneName: tombstone.name,
    operationId,
  });
  renameSync(root, tombstone.path);
  syncProfileDirectory(registry.layout.profilesRoot);
  syncProfileDirectory(tombstone.root);
  updateProfileRecovery(runtimePaths.managedDataRoot, "tombstone-moved");
  const next = registry.remove({ profileId: profile.id, expectedGeneration: input.expectedGeneration });
  updateProfileRecovery(runtimePaths.managedDataRoot, "registry-committed");
  let cleanupPending = false;
  try {
    safeRemovePrivateTree(tombstone.path, tombstone.root);
    clearProfileRecovery(runtimePaths.managedDataRoot);
  } catch { cleanupPending = true; }
  return Object.freeze({ snapshot: next, cleanupPending });
}

export async function backupProfile(profileId: string) {
  const { registry, snapshot } = currentSnapshot();
  const profile = profileById(snapshot, profileId);
  requireMutationReady(snapshot);
  const root = requirePrivateDirectory(registry.profileRoot(profile.id), registry.layout.profilesRoot);
  return withProfileOperation({
    binding: { profileId: snapshot.activeProfileId, generation: snapshot.generation },
    kind: "backup",
    label: `Backing up ${profile.displayName}`,
  }, () => {
    checkpointClosedProfileDatabases(root);
    validateProfileDomainRoot(root);
    const bytes = createProfileBackup({ profileRoot: root, sourceProfile: {
      id: profile.id,
      displayName: profile.displayName,
      type: profile.kind,
    } });
    inspectProfileBackup(bytes);
    return bytes;
  });
}

export function restoreProfile(input: {
  bytes: Uint8Array;
  displayName: string;
  kind: CreatableProfileKind;
  expectedGeneration: number;
}) {
  const { registry, snapshot } = currentSnapshot();
  requireMutationReady(snapshot);
  const operation = profileOperations.begin({
    binding: { profileId: snapshot.activeProfileId, generation: snapshot.generation },
    kind: "restore",
    label: `Restoring ${input.displayName}`,
  });
  try {
    const profileId = registry.allocateProfileId();
    const targetRoot = registry.profileRoot(profileId);
    const inspected = inspectProfileBackup(input.bytes);
    const recovery = beginProfileRecovery({
      managedRoot: runtimePaths.managedDataRoot,
      operation: "restore",
      profileId,
      expectedGeneration: input.expectedGeneration,
      backupManifestSha256: inspected.manifestSha256,
    });
    const receipt = restoreProfileBackup({
      bytes: input.bytes,
      targetRoot,
      restoreMarker: {
        operationId: recovery.journal.operationId,
        profileId,
        backupManifestSha256: inspected.manifestSha256,
      },
    });
    validateProfileDomainRoot(targetRoot);
    updateProfileRecovery(runtimePaths.managedDataRoot, "profile-root-restored");
    const next = registry.create({
      profileId,
      displayName: input.displayName,
      kind: input.kind,
      expectedGeneration: input.expectedGeneration,
    });
    updateProfileRecovery(runtimePaths.managedDataRoot, "registry-committed");
    clearProfileRecovery(runtimePaths.managedDataRoot);
    return Object.freeze({ snapshot: next, profile: profileById(next, profileId), receipt });
  } finally {
    operation.release();
  }
}

export function profileScopePreview(profileId: string) {
  const { registry, snapshot } = currentSnapshot();
  const profile = profileById(snapshot, profileId);
  const root = requirePrivateDirectory(registry.profileRoot(profile.id), registry.layout.profilesRoot);
  const inventory = validatePrivateTree(root, registry.layout.profilesRoot);
  return Object.freeze({
    profile: Object.freeze({ id: profile.id, displayName: profile.displayName, kind: profile.kind, protected: profile.protected }),
    active: profile.id === snapshot.activeProfileId,
    rootToken: basename(root),
    sizeBytes: inventory.sizeBytes,
    categories: [
      "conversations and response feedback",
      "memory",
      "Knowledge and indexes",
      "repository and dataset approvals",
      "preferences and model selection",
      "managed artifacts",
    ] as const,
    sharedExcluded: ["Ollama engine", "installed model weights", "external repository and dataset files"] as const,
  });
}
