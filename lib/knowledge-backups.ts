import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import {
  ensurePrivateDirectory,
  ensurePrivateFile,
  hardenPrivateSqliteFiles,
} from "./private-storage.ts";
import { acquireRuntimeLease } from "./runtime-lease.ts";

export const defaultKnowledgeBackupRetention = 12;
const backupName = /^knowledge-[0-9TZ-]+(?:-[a-z0-9-]+)?\.db$/;
const requiredKnowledgeTables = ["documents", "chunks"] as const;

export type KnowledgeBackup = {
  name: string;
  path: string;
  checksumPath?: string;
};

export type KnowledgeBackupValidation = {
  sha256: string;
  checksumVerified: boolean;
};

type BackupOptions = {
  databasePath: string;
  backupRoot: string;
  retention?: number;
  label?: string;
  now?: () => Date;
};

type RestoreOptions = {
  databasePath: string;
  backupRoot: string;
  retention?: number;
  now?: () => Date;
  runtimeLeasePath?: string;
};

function sha256File(path: string) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function syncFile(path: string) {
  // Windows requires a write-capable handle for FlushFileBuffers/fsync.
  // Opening an already-complete file with r+ preserves its bytes while
  // keeping the durability barrier equivalent across supported platforms.
  const descriptor = openSync(path, "r+");
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}

function requireRegularFile(path: string) {
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new Error("Knowledge backups must be regular local files.");
  }
}

function removeRegularFile(path: string) {
  if (!existsSync(path)) return;
  requireRegularFile(path);
  unlinkSync(path);
}

function normalizedLabel(value: string | undefined) {
  if (!value) return "";
  const label = value.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(label)) {
    throw new Error("Knowledge backup labels may contain only lowercase letters, numbers, and hyphens.");
  }
  return `-${label}`;
}

function backupTimestamp(date: Date) {
  if (!Number.isFinite(date.getTime())) throw new Error("Knowledge backup timestamp is invalid.");
  return date.toISOString().replaceAll(/[:.]/g, "-");
}

function writeChecksum(path: string, checksum: string) {
  const checksumPath = `${path}.sha256`;
  const temporary = `${checksumPath}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${checksum}  ${basename(path)}\n`, { encoding: "utf8", mode: 0o600 });
  ensurePrivateFile(temporary);
  syncFile(temporary);
  renameSync(temporary, checksumPath);
  ensurePrivateFile(checksumPath);
  return checksumPath;
}

function expectedChecksum(path: string) {
  const checksumPath = `${path}.sha256`;
  if (!existsSync(checksumPath)) return undefined;
  ensurePrivateFile(checksumPath);
  const match = /^([a-f0-9]{64})\s{2}([^\r\n]+)\r?\n?$/.exec(readFileSync(checksumPath, "utf8"));
  if (!match || match[2] !== basename(path)) {
    throw new Error("Knowledge backup checksum metadata is damaged.");
  }
  return match[1];
}

function validateKnowledgeDatabase(path: string) {
  ensurePrivateFile(path);
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const integrityRows = database.prepare("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
    if (integrityRows.length !== 1 || integrityRows[0]?.quick_check !== "ok") {
      throw new Error("Knowledge backup failed SQLite integrity validation.");
    }
    const tableRows = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as Array<{ name: string }>;
    const tables = new Set(tableRows.map((row) => row.name));
    if (requiredKnowledgeTables.some((table) => !tables.has(table))) {
      throw new Error("Knowledge backup is not a Rangabot Knowledge Vault index.");
    }
  } finally {
    database.close();
  }
}

export function getKnowledgeBackupRetention(value = process.env.RANGABOT_KNOWLEDGE_BACKUP_RETENTION) {
  if (value === undefined || value.trim() === "") return defaultKnowledgeBackupRetention;
  if (!/^\d+$/.test(value)) throw new Error("RANGABOT_KNOWLEDGE_BACKUP_RETENTION must be a whole number from 2 to 100.");
  const retention = Number(value);
  if (retention < 2 || retention > 100) throw new Error("RANGABOT_KNOWLEDGE_BACKUP_RETENTION must be a whole number from 2 to 100.");
  return retention;
}

export function listKnowledgeBackups(backupRoot: string): KnowledgeBackup[] {
  if (!existsSync(backupRoot)) return [];
  ensurePrivateDirectory(backupRoot);
  return readdirSync(backupRoot)
    .filter((name) => backupName.test(name))
    .sort()
    .reverse()
    .map((name) => {
      const path = resolve(backupRoot, name);
      requireRegularFile(path);
      ensurePrivateFile(path);
      const checksumPath = `${path}.sha256`;
      if (existsSync(checksumPath)) {
        requireRegularFile(checksumPath);
        ensurePrivateFile(checksumPath);
      }
      return { name, path, checksumPath: existsSync(checksumPath) ? checksumPath : undefined };
    });
}

export function validateKnowledgeBackup(path: string): KnowledgeBackupValidation {
  requireRegularFile(path);
  validateKnowledgeDatabase(path);
  const sha256 = sha256File(path);
  const expected = expectedChecksum(path);
  if (expected !== undefined && expected !== sha256) {
    throw new Error("Knowledge backup checksum validation failed.");
  }
  return { sha256, checksumVerified: expected !== undefined };
}

export function pruneKnowledgeBackups(backupRoot: string, retention = getKnowledgeBackupRetention()) {
  const backups = listKnowledgeBackups(backupRoot);
  const removed = backups.slice(retention);
  for (const item of removed) {
    removeRegularFile(item.path);
    removeRegularFile(`${item.path}.sha256`);
  }
  return removed.map((item) => item.name);
}

export async function createKnowledgeBackup(options: BackupOptions) {
  const databasePath = resolve(options.databasePath);
  const backupRoot = resolve(options.backupRoot);
  const retention = options.retention ?? getKnowledgeBackupRetention();
  getKnowledgeBackupRetention(String(retention));
  if (!existsSync(databasePath)) throw new Error("No knowledge index exists to back up.");
  ensurePrivateFile(databasePath);
  ensurePrivateDirectory(backupRoot);

  const stamp = backupTimestamp((options.now ?? (() => new Date()))());
  const name = `knowledge-${stamp}-${randomUUID().slice(0, 8)}${normalizedLabel(options.label)}.db`;
  const target = resolve(backupRoot, name);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const source = new DatabaseSync(databasePath, { readOnly: true });
    try {
      await backup(source, temporary);
    } finally {
      source.close();
    }
    ensurePrivateFile(temporary);
    validateKnowledgeDatabase(temporary);
    syncFile(temporary);
    renameSync(temporary, target);
    ensurePrivateFile(target);
    const sha256 = sha256File(target);
    const checksumPath = writeChecksum(target, sha256);
    pruneKnowledgeBackups(backupRoot, retention);
    hardenPrivateSqliteFiles(databasePath);
    return { name, path: target, checksumPath, sha256 };
  } catch (error) {
    removeRegularFile(temporary);
    removeRegularFile(target);
    removeRegularFile(`${target}.sha256`);
    throw error;
  }
}

function copyAndValidateBackup(source: KnowledgeBackup, destination: string) {
  const validation = validateKnowledgeBackup(source.path);
  copyFileSync(source.path, destination);
  ensurePrivateFile(destination);
  syncFile(destination);
  validateKnowledgeDatabase(destination);
  if (sha256File(destination) !== validation.sha256) {
    throw new Error("Knowledge backup changed while it was being prepared for restore.");
  }
  return validation;
}

async function restoreLatestKnowledgeBackupWithLeaseHeld(options: RestoreOptions) {
  const databasePath = resolve(options.databasePath);
  const backupRoot = resolve(options.backupRoot);
  const retention = options.retention ?? getKnowledgeBackupRetention();
  getKnowledgeBackupRetention(String(retention));
  const selected = listKnowledgeBackups(backupRoot)[0];
  if (!selected) throw new Error("No local Knowledge Vault backup is available.");

  ensurePrivateDirectory(dirname(databasePath));
  const staged = `${databasePath}.restore.${randomUUID()}.tmp`;
  let recovery: Awaited<ReturnType<typeof createKnowledgeBackup>> | undefined;
  let selectedValidation: KnowledgeBackupValidation | undefined;
  try {
    selectedValidation = copyAndValidateBackup(selected, staged);
    if (existsSync(databasePath)) {
      recovery = await createKnowledgeBackup({
        databasePath,
        backupRoot,
        retention,
        label: "pre-restore",
        now: options.now,
      });
    }

    for (const suffix of ["-wal", "-shm", "-journal"]) removeRegularFile(`${databasePath}${suffix}`);
    renameSync(staged, databasePath);
    ensurePrivateFile(databasePath);
    validateKnowledgeDatabase(databasePath);
    if (sha256File(databasePath) !== selectedValidation.sha256) {
      throw new Error("Restored Knowledge Vault does not match the validated backup.");
    }
    hardenPrivateSqliteFiles(databasePath);
    return {
      restored: selected.name,
      checksumVerified: selectedValidation.checksumVerified,
      recoveryBackup: recovery?.name,
    };
  } catch (error) {
    removeRegularFile(staged);
    if (recovery && existsSync(recovery.path)) {
      const rollbackStage = `${databasePath}.recovery.${randomUUID()}.tmp`;
      try {
        copyAndValidateBackup(recovery, rollbackStage);
        for (const suffix of ["-wal", "-shm", "-journal"]) removeRegularFile(`${databasePath}${suffix}`);
        renameSync(rollbackStage, databasePath);
        ensurePrivateFile(databasePath);
      } catch (recoveryError) {
        removeRegularFile(rollbackStage);
        throw new AggregateError([error, recoveryError], "Knowledge restore failed and the automatic recovery copy could not be restored.");
      }
    }
    throw error;
  }
}

export async function restoreLatestKnowledgeBackup(options: RestoreOptions) {
  // Rollback is an offline operation. Taking the same cross-process lease as
  // the app both refuses an active runtime and prevents a runtime from starting
  // midway through the destructive replace.
  const runtimeLease = acquireRuntimeLease({
    path: options.runtimeLeasePath,
    role: "maintenance",
  });
  try {
    return await restoreLatestKnowledgeBackupWithLeaseHeld(options);
  } finally {
    runtimeLease.release();
  }
}
