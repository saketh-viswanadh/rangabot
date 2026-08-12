import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MAX_PROFILE_ENTRIES = 100_000;
const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;
const MAX_RESTORED_REFERENCES = 2_048;

const knownSqlitePaths = Object.freeze([
  "knowledge/indexes/knowledge.db",
  "rangabot-memory.db",
  "rangabot.db",
]);
const knowledgeBackupDatabasePath = /^knowledge\/backups\/knowledge-[0-9TZ-]+(?:-[a-z0-9-]+)?\.db$/;

const knownJsonStores = Object.freeze(new Map<string, Readonly<{
  maximumBytes: number;
  validate: (value: unknown) => boolean;
}>>([
  [".rangabot-restore-origin.json", { maximumBytes: 4 * 1024, validate: validRestoreOrigin }],
  ["datasets.json", { maximumBytes: MAX_REGISTRY_BYTES, validate: validDatasets }],
  ["desktop-preferences.json", { maximumBytes: 4_096, validate: validDesktopPreferences }],
  ["model-preferences.json", { maximumBytes: 2_048, validate: validModelPreferences }],
  ["repositories.json", { maximumBytes: MAX_REGISTRY_BYTES, validate: validRepositories }],
  ["restored-external-references.json", { maximumBytes: MAX_REGISTRY_BYTES, validate: validRestoredReferences }],
  ["sql-confirmations.json", { maximumBytes: MAX_REGISTRY_BYTES, validate: validSqlConfirmations }],
]));

function inside(root: string, candidate: string) {
  const child = relative(root, candidate);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function canonicalTimestamp(value: unknown, nullable = false) {
  if (nullable && value === null) return true;
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function boundedString(value: unknown, maximum: number, allowEmpty = false) {
  return typeof value === "string" && value.length <= maximum && (allowEmpty || value.length > 0);
}

function validRepositories(value: unknown) {
  return Array.isArray(value) && value.length <= MAX_RESTORED_REFERENCES && value.every((item) => {
    if (!record(item) || !boundedString(item.id, 120) || !boundedString(item.name, 240)
      || !boundedString(item.path, 4_096) || !isAbsolute(item.path as string)
      || !canonicalTimestamp(item.addedAt)) return false;
    if (item.rootIdentity === undefined) return true;
    return record(item.rootIdentity)
      && typeof item.rootIdentity.device === "string" && /^\d+$/.test(item.rootIdentity.device)
      && typeof item.rootIdentity.inode === "string" && /^\d+$/.test(item.rootIdentity.inode);
  });
}

function validDatasetIdentity(value: unknown) {
  return record(value) && boundedString(value.device, 80) && boundedString(value.inode, 80)
    && Number.isSafeInteger(value.sizeBytes) && Number(value.sizeBytes) > 0
    && boundedString(value.modifiedNs, 80) && boundedString(value.changedNs, 80)
    && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256);
}

function validDatasets(value: unknown) {
  return Array.isArray(value) && value.length <= MAX_RESTORED_REFERENCES && value.every((item) => {
    if (!record(item) || !boundedString(item.id, 120) || !boundedString(item.name, 240)
      || !boundedString(item.path, 4_096) || !isAbsolute(item.path as string)
      || !["csv", "parquet", "duckdb"].includes(String(item.format))
      || !Number.isSafeInteger(item.sizeBytes) || Number(item.sizeBytes) < 0
      || !canonicalTimestamp(item.addedAt)) return false;
    const legacy = item.approvalVersion === undefined && item.fileIdentity === undefined;
    return legacy || (item.approvalVersion === 2 && validDatasetIdentity(item.fileIdentity));
  });
}

function validSqlConfirmations(value: unknown) {
  const fields = ["id", "tokenHash", "datasetId", "datasetSha256", "query", "querySha256", "expiresAt"] as const;
  return Array.isArray(value) && value.every((item) => record(item)
    && fields.every((field) => boundedString(item[field], field === "query" ? 1_000_000 : 4_096))
    && canonicalTimestamp(item.expiresAt));
}

function validDesktopPreferences(value: unknown) {
  if (!record(value) || !exactKeys(value, [
    "appearance", "import", "palette", "preferredName", "revision", "schemaVersion", "updatedAt", "welcomeMode",
  ]) || value.schemaVersion !== 1 || !boundedString(value.preferredName, 160, true)
    || !["mixed", "quotes", "jokes", "thoughts", "books"].includes(String(value.welcomeMode))
    || (value.appearance !== null && value.appearance !== "light" && value.appearance !== "dark")
    || !["rangabot", "monochrome", "graphite", "cement", "moss", "harbor", "plum", "ember"].includes(String(value.palette))
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
    || !canonicalTimestamp(value.updatedAt, true)) return false;
  if (value.import === null) return true;
  return record(value.import) && exactKeys(value.import, ["importedAt", "source"])
    && value.import.source === "legacy-loopback-manual" && canonicalTimestamp(value.import.importedAt);
}

function validModelPreferences(value: unknown) {
  if (!record(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2)
    || !boundedString(value.selectedModel, 192) || !Number.isSafeInteger(value.revision)
    || Number(value.revision) < 0 || !canonicalTimestamp(value.updatedAt, true)) return false;
  if (value.schemaVersion === 1) {
    return exactKeys(value, ["revision", "schemaVersion", "selectedModel", "updatedAt"]);
  }
  return exactKeys(value, ["contextTokens", "revision", "schemaVersion", "selectedModel", "updatedAt"])
    && Number.isSafeInteger(value.contextTokens) && Number(value.contextTokens) >= 512
    && Number(value.contextTokens) <= 131_072;
}

function validRestoredReferences(value: unknown) {
  if (!record(value) || !exactKeys(value, ["references", "schemaVersion", "status"])
    || value.schemaVersion !== 1 || value.status !== "inactive-reapproval-required"
    || !Array.isArray(value.references) || value.references.length > MAX_RESTORED_REFERENCES) return false;
  return value.references.every((item) => record(item)
    && exactKeys(item, ["id", "kind", "name", "originalPath", "status"])
    && (item.kind === "repository" || item.kind === "dataset")
    && item.status === "inactive-reapproval-required"
    && boundedString(item.id, 120) && boundedString(item.name, 240)
    && boundedString(item.originalPath, 4_096));
}

function validRestoreOrigin(value: unknown) {
  return record(value) && exactKeys(value, ["backupManifestSha256", "kind", "operationId", "profileId", "schemaVersion"])
    && value.schemaVersion === 1 && value.kind === "rangabot-profile-restore-origin"
    && typeof value.operationId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.operationId)
    && typeof value.profileId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.profileId)
    && typeof value.backupManifestSha256 === "string" && /^[0-9a-f]{64}$/.test(value.backupManifestSha256);
}

function requirePrivateOwner(status: Stats, label: string) {
  if (process.platform !== "win32" && process.getuid
    && (status.uid !== process.getuid() || (status.mode & 0o077) !== 0)) {
    throw new Error(`${label} must be owned by the current user and owner-private.`);
  }
}

function readKnownJson(path: string, maximumBytes: number, validate: (value: unknown) => boolean) {
  const before = lstatSync(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== BigInt(1)
    || before.size > BigInt(maximumBytes)) throw new Error("A known profile JSON store is unsafe or too large.");
  const descriptor = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== BigInt(1) || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size || opened.mtimeNs !== before.mtimeNs || opened.ctimeNs !== before.ctimeNs) {
      throw new Error("A known profile JSON store changed during validation.");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(descriptor, "utf8")); }
    catch { throw new Error("A known profile JSON store is malformed."); }
    const after = lstatSync(path, { bigint: true });
    if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino
      || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) {
      throw new Error("A known profile JSON store changed during validation.");
    }
    if (!validate(parsed)) throw new Error("A known profile JSON store has an incompatible schema.");
  } finally {
    closeSync(descriptor);
  }
}

function validateSqlite(path: string) {
  const before = lstatSync(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== BigInt(1)) {
    throw new Error("A known profile SQLite database is unsafe.");
  }
  const database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  try {
    database.enableLoadExtension(false);
    database.exec("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;");
    const rows = database.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
    if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== "ok") {
      throw new Error("A known profile SQLite database failed its integrity check.");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("integrity check")) throw error;
    throw new Error("A known profile SQLite database failed its integrity check.", { cause: error });
  } finally {
    database.close();
  }
  const after = lstatSync(path, { bigint: true });
  if (after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino
    || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
    throw new Error("A known profile SQLite database changed during validation.");
  }
}

export type ProfileDomainValidationReceipt = Readonly<{
  root: string;
  directories: number;
  files: number;
  sqliteDatabases: number;
  jsonStores: number;
}>;

/**
 * Read-only semantic gate for a closed, private profile tree. It verifies the
 * complete filesystem boundary first, then validates every known mutable store
 * without following links or consulting external repository/dataset targets.
 */
export function validateProfileDomainRoot(profileRoot: string): ProfileDomainValidationReceipt {
  const root = resolve(profileRoot);
  const rootStatus = lstatSync(root);
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
    throw new Error("Profile domain validation requires a real directory.");
  }
  requirePrivateOwner(rootStatus, "Profile domain root");
  let directories = 1;
  let files = 0;
  const portablePaths = new Set<string>();
  const filePaths = new Set<string>();
  const visit = (directory: string) => {
    const localNames = new Set<string>();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.name || entry.name !== entry.name.normalize("NFC") || entry.name === "." || entry.name === "..") {
        throw new Error("Profile domain validation found a non-canonical path name.");
      }
      const localKey = entry.name.toLocaleLowerCase("en-US");
      if (localNames.has(localKey)) throw new Error("Profile domain validation found colliding path names.");
      localNames.add(localKey);
      const path = resolve(directory, entry.name);
      if (!inside(root, path)) throw new Error("Profile domain validation found a path outside the profile root.");
      const relativePath = relative(root, path).split(sep).join("/");
      const portableKey = relativePath.normalize("NFC").toLocaleLowerCase("en-US");
      if (portablePaths.has(portableKey)) throw new Error("Profile domain validation found colliding profile paths.");
      portablePaths.add(portableKey);
      const status = lstatSync(path);
      if (status.isSymbolicLink()) throw new Error("Profile domain validation refuses symbolic links.");
      requirePrivateOwner(status, "Profile domain entry");
      if (status.isDirectory()) {
        directories += 1;
        if (directories + files > MAX_PROFILE_ENTRIES) throw new Error("Profile domain contains too many entries.");
        visit(path);
      } else {
        if (!status.isFile() || status.nlink !== 1) {
          throw new Error("Profile domain validation refuses non-regular or hard-linked entries.");
        }
        files += 1;
        filePaths.add(relativePath);
        if (directories + files > MAX_PROFILE_ENTRIES) throw new Error("Profile domain contains too many entries.");
      }
    }
  };
  visit(root);

  let sqliteDatabases = 0;
  const sqlitePaths = [
    ...knownSqlitePaths,
    ...[...filePaths].filter((path) => knowledgeBackupDatabasePath.test(path)),
  ].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  for (const relativePath of sqlitePaths) {
    const path = resolve(root, ...relativePath.split("/"));
    if (!inside(root, path)) throw new Error("A known profile SQLite path escaped its root.");
    try { lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    validateSqlite(path);
    sqliteDatabases += 1;
  }

  let jsonStores = 0;
  for (const [relativePath, validator] of knownJsonStores) {
    const path = resolve(root, relativePath);
    if (!inside(root, path)) throw new Error("A known profile JSON path escaped its root.");
    try { lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    readKnownJson(path, validator.maximumBytes, validator.validate);
    jsonStores += 1;
  }

  return Object.freeze({ root, directories, files, sqliteDatabases, jsonStores });
}
