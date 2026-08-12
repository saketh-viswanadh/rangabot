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
import { syncProfileDirectory } from "./profile-recovery.ts";

export const PROFILE_BACKUP_SCHEMA_VERSION = 1;
export const PROFILE_BACKUP_MAX_BYTES = 512 * 1024 * 1024;
export const PROFILE_RESTORED_EXTERNAL_REFERENCES = "restored-external-references.json";
export const PROFILE_RESTORE_ORIGIN_MARKER = ".rangabot-restore-origin.json";

type BackupCategory = "conversations" | "memory" | "knowledge" | "preferences" | "artifacts" | "other";
const backupCategories = ["artifacts", "conversations", "knowledge", "memory", "other", "preferences"] as const;
const excludedCategoryList = ["credentials", "operational-logs", "shared-model-weights", "transient-locks", "active-external-approvals"] as const;
const maximumBackupFiles = 100_000;
const maximumExternalReferences = 2_048;

type BackupFile = Readonly<{
  path: string;
  bytes: number;
  sha256: string;
  category: BackupCategory;
  data: string;
}>;

type ExternalReference = Readonly<{
  kind: "repository" | "dataset";
  id: string;
  name: string;
  originalPath: string;
  status: "inactive-reapproval-required";
}>;

export type ProfileBackupEnvelope = Readonly<{
  schemaVersion: typeof PROFILE_BACKUP_SCHEMA_VERSION;
  kind: "rangabot-profile-backup";
  sourceProfile: Readonly<{ id: string; displayName: string; type: "default" | "personal" | "testing" }>;
  createdAt: string;
  includedCategories: BackupCategory[];
  excludedCategories: string[];
  externalReferences: ExternalReference[];
  files: BackupFile[];
  manifestSha256: string;
}>;

const excludedRoots = new Set([
  "credentials",
  "logs",
  "tmp",
  "profile-backups",
  "tombstones",
  "models",
]);
const excludedFiles = new Set([
  PROFILE_RESTORE_ORIGIN_MARKER,
  "repositories.json",
  "datasets.json",
  "sql-confirmations.json",
  "rangabot.db-runtime.lock",
]);

export type ProfileRestoreOriginMarker = Readonly<{
  schemaVersion: 1;
  kind: "rangabot-profile-restore-origin";
  operationId: string;
  profileId: string;
  backupManifestSha256: string;
}>;

function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function byteSorted(left: string, right: string) {
  return Buffer.from(left).compare(Buffer.from(right));
}

function exactKeys(value: object, expected: readonly string[]) {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function canonicalTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function safeRelativePath(value: string) {
  if (!value || value !== value.normalize("NFC") || value.includes("\0") || value.includes("\\") || isAbsolute(value)) return false;
  const components = value.split("/");
  return components.every((component) => component && component !== "." && component !== ".."
    && component.length <= 255 && /^[\x20-\x7e]+$/.test(component));
}

function portablePathKey(value: string) {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function requireCanonicalDirectoryEntries(names: readonly string[]) {
  const keys = new Set<string>();
  for (const name of names) {
    if (name !== name.normalize("NFC") || !name || name === "." || name === ".."
      || name.length > 255 || !/^[\x20-\x7e]+$/.test(name)) {
      throw new Error("Profile backup path names must use bounded printable ASCII.");
    }
    const key = portablePathKey(name);
    if (keys.has(key)) throw new Error("Profile backup refuses case or Unicode-colliding paths.");
    keys.add(key);
  }
}

function pathInside(root: string, candidate: string) {
  const remainder = relative(root, candidate);
  return remainder === "" || (!isAbsolute(remainder) && remainder !== ".." && !remainder.startsWith(`..${sep}`));
}

function exactRegularFile(path: string) {
  const status = lstatSync(path, { bigint: true });
  if (status.isSymbolicLink() || !status.isFile() || status.nlink !== BigInt(1)) {
    throw new Error("Profile backup accepts only private regular files without hard links.");
  }
  return status;
}

function categoryFor(path: string): BackupCategory {
  if (path === "rangabot.db" || path.startsWith("rangabot.db-")) return "conversations";
  if (path === "rangabot-memory.db" || path.startsWith("rangabot-memory.db-")) return "memory";
  if (path === "knowledge" || path.startsWith("knowledge/")) return "knowledge";
  if (path === "artifacts" || path.startsWith("artifacts/")) return "artifacts";
  if (path.endsWith("preferences.json") || path === "desktop-preferences.json" || path === "model-preferences.json") return "preferences";
  return "other";
}

function sourceProfile(value: ProfileBackupEnvelope["sourceProfile"]) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !exactKeys(value, ["displayName", "id", "type"])
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id)
    || !value.displayName || value.displayName !== value.displayName.normalize("NFC")
    || value.displayName !== value.displayName.trim()
    || Array.from(value.displayName).length > 64
    || !["default", "personal", "testing"].includes(value.type)) {
    throw new Error("Profile backup source identity is invalid.");
  }
  return Object.freeze({ id: value.id, displayName: value.displayName, type: value.type });
}

function readExternalReferences(path: string, kind: "repository" | "dataset"): ExternalReference[] {
  let status;
  try { status = exactRegularFile(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (status.size > BigInt(2_000_000)) throw new Error("Profile external-reference registry exceeds the backup limit.");
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("Profile external-reference registry is malformed.");
  return parsed.map((entry): ExternalReference => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Profile external reference is malformed.");
    const record = entry as Record<string, unknown>;
    const id = record.id;
    const name = record.name;
    const originalPath = record.path;
    if (typeof id !== "string" || id.length > 120 || typeof name !== "string" || !name.trim()
      || Array.from(name).length > 120 || typeof originalPath !== "string" || originalPath.length > 4096) {
      throw new Error("Profile external reference is invalid.");
    }
    return Object.freeze({ kind, id, name, originalPath, status: "inactive-reapproval-required" });
  });
}

function manifestPayload(envelope: Omit<ProfileBackupEnvelope, "manifestSha256">) {
  return JSON.stringify(envelope);
}

export function createProfileBackup(input: {
  profileRoot: string;
  sourceProfile: ProfileBackupEnvelope["sourceProfile"];
  now?: string;
}): Uint8Array {
  const root = resolve(input.profileRoot);
  const rootStatus = lstatSync(root, { bigint: true });
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) throw new Error("Profile backup source must be a real directory.");
  if (process.platform !== "win32" && process.getuid
    && (rootStatus.uid !== BigInt(process.getuid()) || (rootStatus.mode & BigInt(0o077)) !== BigInt(0))) {
    throw new Error("Profile backup source must be owner-private.");
  }
  const createdAt = input.now ?? new Date().toISOString();
  if (!canonicalTimestamp(createdAt)) throw new Error("Profile backup creation time is invalid.");
  const files: BackupFile[] = [];
  let totalBytes = 0;

  const visit = (directory: string) => {
    const entries = readdirSync(directory, { withFileTypes: true });
    requireCanonicalDirectoryEntries(entries.map(({ name }) => name));
    for (const entry of entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)))) {
      const absolute = resolve(directory, entry.name);
      if (!pathInside(root, absolute)) throw new Error("Profile backup path escapes its source root.");
      const relativePath = relative(root, absolute).split(sep).join("/");
      const first = relativePath.split("/", 1)[0];
      if (excludedRoots.has(portablePathKey(first)) || excludedFiles.has(portablePathKey(relativePath))) continue;
      const status = lstatSync(absolute, { bigint: true });
      if (status.isSymbolicLink()) throw new Error("Profile backup refuses symbolic links.");
      if (status.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!status.isFile() || status.nlink !== BigInt(1)) throw new Error("Profile backup refuses non-regular or hard-linked entries.");
      const bytes = readFileSync(absolute);
      const after = lstatSync(absolute, { bigint: true });
      if (after.dev !== status.dev || after.ino !== status.ino || after.size !== status.size
        || after.mtimeNs !== status.mtimeNs || after.ctimeNs !== status.ctimeNs) {
        throw new Error("Profile data changed while the backup was being created.");
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > PROFILE_BACKUP_MAX_BYTES) throw new Error("Profile backup exceeds the local size limit.");
      files.push(Object.freeze({
        path: relativePath,
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
        category: categoryFor(relativePath),
        data: bytes.toString("base64"),
      }));
    }
  };
  visit(root);
  files.sort((left, right) => byteSorted(left.path, right.path));

  const externalReferences = [
    ...readExternalReferences(resolve(root, "repositories.json"), "repository"),
    ...readExternalReferences(resolve(root, "datasets.json"), "dataset"),
  ].sort((left, right) => byteSorted(`${left.kind}\0${left.id}`, `${right.kind}\0${right.id}`));
  const includedCategories = [...new Set(files.map(({ category }) => category))].sort();
  const payload = Object.freeze({
    schemaVersion: PROFILE_BACKUP_SCHEMA_VERSION,
    kind: "rangabot-profile-backup" as const,
    sourceProfile: sourceProfile(input.sourceProfile),
    createdAt,
    includedCategories,
    excludedCategories: [...excludedCategoryList],
    externalReferences,
    files,
  });
  const envelope: ProfileBackupEnvelope = Object.freeze({ ...payload, manifestSha256: sha256(manifestPayload(payload)) });
  const encoded = Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
  if (encoded.byteLength > PROFILE_BACKUP_MAX_BYTES) throw new Error("Profile backup exceeds the local size limit.");
  return encoded;
}

function parseBackup(bytes: Uint8Array): { envelope: ProfileBackupEnvelope; decoded: Array<{ path: string; bytes: Buffer }> } {
  if (bytes.byteLength < 2 || bytes.byteLength > PROFILE_BACKUP_MAX_BYTES) throw new Error("Profile backup has an invalid size.");
  let value: unknown;
  try { value = JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch { throw new Error("Profile backup is not valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Profile backup envelope is malformed.");
  const record = value as Record<string, unknown>;
  const expectedEnvelopeKeys = ["createdAt", "excludedCategories", "externalReferences", "files", "includedCategories", "kind", "manifestSha256", "schemaVersion", "sourceProfile"];
  if (Object.keys(record).sort().join(",") !== expectedEnvelopeKeys.join(",")
    || record.schemaVersion !== PROFILE_BACKUP_SCHEMA_VERSION || record.kind !== "rangabot-profile-backup"
    || !canonicalTimestamp(record.createdAt) || typeof record.manifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.manifestSha256)) {
    throw new Error("Profile backup envelope has an incompatible schema.");
  }
  const envelope = record as unknown as ProfileBackupEnvelope;
  sourceProfile(envelope.sourceProfile);
  if (!Array.isArray(envelope.files) || envelope.files.length > maximumBackupFiles
    || !Array.isArray(envelope.includedCategories)
    || !Array.isArray(envelope.excludedCategories) || !Array.isArray(envelope.externalReferences)) {
    throw new Error("Profile backup collections are malformed.");
  }
  const { manifestSha256, ...payload } = envelope;
  if (sha256(manifestPayload(payload)) !== manifestSha256) throw new Error("Profile backup manifest integrity check failed.");
  const seen = new Set<string>();
  const portableSeen = new Set<string>();
  let priorPath: string | undefined;
  let total = 0;
  const decoded = envelope.files.map((file) => {
    if (!file || typeof file !== "object" || Array.isArray(file)
      || !exactKeys(file, ["bytes", "category", "data", "path", "sha256"])
      || !safeRelativePath(file.path) || seen.has(file.path) || portableSeen.has(portablePathKey(file.path))
      || (priorPath !== undefined && byteSorted(priorPath, file.path) >= 0)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[0-9a-f]{64}$/.test(file.sha256)
      || !["conversations", "memory", "knowledge", "preferences", "artifacts", "other"].includes(file.category)
      || typeof file.data !== "string") {
      throw new Error("Profile backup file inventory is invalid.");
    }
    if (excludedRoots.has(portablePathKey(file.path.split("/", 1)[0])) || excludedFiles.has(portablePathKey(file.path))) {
      throw new Error("Profile backup contains an excluded private category.");
    }
    const content = Buffer.from(file.data, "base64");
    if (content.toString("base64") !== file.data || content.byteLength !== file.bytes || sha256(content) !== file.sha256) {
      throw new Error("Profile backup file integrity check failed.");
    }
    total += content.byteLength;
    if (total > PROFILE_BACKUP_MAX_BYTES) throw new Error("Profile backup content exceeds the local size limit.");
    seen.add(file.path);
    portableSeen.add(portablePathKey(file.path));
    priorPath = file.path;
    return { path: file.path, bytes: content };
  });
  const expectedIncluded = [...new Set(envelope.files.map(({ category }) => category))].sort();
  if (JSON.stringify(envelope.includedCategories) !== JSON.stringify(expectedIncluded)
    || envelope.includedCategories.some((category) => !backupCategories.includes(category as (typeof backupCategories)[number]))
    || JSON.stringify(envelope.excludedCategories) !== JSON.stringify(excludedCategoryList)
    || envelope.externalReferences.length > maximumExternalReferences) {
    throw new Error("Profile backup category inventory is invalid.");
  }
  const referenceKeys = new Set<string>();
  let priorReference: string | undefined;
  for (const reference of envelope.externalReferences) {
    if (!reference || typeof reference !== "object" || Array.isArray(reference)
      || !exactKeys(reference, ["id", "kind", "name", "originalPath", "status"])
      || (reference.kind !== "repository" && reference.kind !== "dataset")
      || reference.status !== "inactive-reapproval-required" || typeof reference.id !== "string"
      || !reference.id || reference.id.length > 120
      || typeof reference.name !== "string" || !reference.name.trim() || Array.from(reference.name).length > 120
      || typeof reference.originalPath !== "string" || !reference.originalPath || reference.originalPath.length > 4096) {
      throw new Error("Profile backup external-reference inventory is invalid.");
    }
    const key = `${reference.kind}\0${reference.id}`;
    if (referenceKeys.has(key) || (priorReference !== undefined && byteSorted(priorReference, key) >= 0)) {
      throw new Error("Profile backup external-reference inventory is not canonical.");
    }
    referenceKeys.add(key);
    priorReference = key;
  }
  return { envelope, decoded };
}

export function inspectProfileBackup(bytes: Uint8Array) {
  const parsed = parseBackup(bytes);
  return Object.freeze({
    sourceProfile: parsed.envelope.sourceProfile,
    createdAt: parsed.envelope.createdAt,
    includedCategories: parsed.envelope.includedCategories,
    excludedCategories: parsed.envelope.excludedCategories,
    files: parsed.decoded.length,
    externalReferences: parsed.envelope.externalReferences.length,
    manifestSha256: parsed.envelope.manifestSha256,
  });
}

function writePrivateFile(path: string, bytes: Uint8Array) {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    fchmodSync(descriptor, 0o600);
    const status = fstatSync(descriptor);
    if (!status.isFile()) throw new Error("Restored profile entry is not a regular file.");
  } finally {
    closeSync(descriptor);
  }
}

export function restoreProfileBackup(input: {
  bytes: Uint8Array;
  targetRoot: string;
  writeFile?: (path: string, bytes: Uint8Array) => void;
  restoreMarker?: Readonly<{ operationId: string; profileId: string; backupManifestSha256: string }>;
}) {
  const parsed = parseBackup(input.bytes);
  const target = resolve(input.targetRoot);
  const parent = dirname(target);
  const parentStatus = lstatSync(parent);
  if (parentStatus.isSymbolicLink() || !parentStatus.isDirectory()) throw new Error("Profile restore parent must be a real directory.");
  if (process.platform !== "win32" && process.getuid
    && (parentStatus.uid !== process.getuid() || (parentStatus.mode & 0o077) !== 0)) {
    throw new Error("Profile restore parent must be owner-private.");
  }
  try {
    lstatSync(target);
    throw new Error("Profile restore target already exists.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const marker = input.restoreMarker === undefined ? null : parseRestoreOriginMarker({
    schemaVersion: 1,
    kind: "rangabot-profile-restore-origin",
    ...input.restoreMarker,
  });
  if (marker && marker.profileId !== basename(target)) throw new Error("Profile restore identity does not match its target.");
  if (marker && marker.backupManifestSha256 !== parsed.envelope.manifestSha256) {
    throw new Error("Profile restore identity does not match its backup manifest.");
  }
  const stage = resolve(parent, `.${basename(target)}.restore-${marker?.operationId ?? randomUUID()}`);
  if (!pathInside(parent, stage)) throw new Error("Profile restore staging path escapes its parent.");
  const writer = input.writeFile ?? writePrivateFile;
  try {
    mkdirSync(stage, { mode: 0o700 });
    if (marker) {
      writePrivateFile(resolve(stage, PROFILE_RESTORE_ORIGIN_MARKER), Buffer.from(`${JSON.stringify(marker)}\n`, "utf8"));
    }
    for (const file of parsed.decoded) {
      const destination = resolve(stage, ...file.path.split("/"));
      if (!pathInside(stage, destination)) throw new Error("Profile restore path escapes its staging root.");
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writer(destination, file.bytes);
    }
    if (parsed.envelope.externalReferences.length) {
      const referenceBytes = Buffer.from(`${JSON.stringify({
        schemaVersion: 1,
        status: "inactive-reapproval-required",
        references: parsed.envelope.externalReferences,
      }, null, 2)}\n`, "utf8");
      writer(resolve(stage, PROFILE_RESTORED_EXTERNAL_REFERENCES), referenceBytes);
    }
    renameSync(stage, target);
    syncProfileDirectory(parent);
  } catch (error) {
    try { rmSync(stage, { recursive: true, force: true }); } catch { /* Preserve the restore failure. */ }
    throw error;
  }
  return Object.freeze({
    sourceProfile: parsed.envelope.sourceProfile,
    restoredFiles: parsed.decoded.length,
    externalReferences: parsed.envelope.externalReferences.length,
    manifestSha256: parsed.envelope.manifestSha256,
  });
}

function parseRestoreOriginMarker(value: unknown): ProfileRestoreOriginMarker {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Profile restore origin marker is malformed.");
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["backupManifestSha256", "kind", "operationId", "profileId", "schemaVersion"])
    || record.schemaVersion !== 1 || record.kind !== "rangabot-profile-restore-origin"
    || typeof record.operationId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.operationId)
    || typeof record.profileId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.profileId)
    || typeof record.backupManifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.backupManifestSha256)) {
    throw new Error("Profile restore origin marker is invalid.");
  }
  return Object.freeze(record as unknown as ProfileRestoreOriginMarker);
}

export function readProfileRestoreOriginMarker(profileRoot: string) {
  const root = resolve(profileRoot);
  const markerPath = resolve(root, PROFILE_RESTORE_ORIGIN_MARKER);
  if (!pathInside(root, markerPath)) throw new Error("Profile restore origin marker escaped its profile root.");
  const status = exactRegularFile(markerPath);
  if (status.size > BigInt(4 * 1024)) throw new Error("Profile restore origin marker exceeds its size limit.");
  return parseRestoreOriginMarker(JSON.parse(readFileSync(markerPath, "utf8")) as unknown);
}
