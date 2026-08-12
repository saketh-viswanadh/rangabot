import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { ensurePrivateDirectory, ensurePrivateFile } from "./private-storage.ts";
import { runtimePaths } from "./runtime-paths.ts";

export type SqlConfirmationRecord = {
  id: string;
  tokenHash: string;
  datasetId: string;
  datasetSha256: string;
  query: string;
  querySha256: string;
  expiresAt: string;
};

export const defaultSqlConfirmationStorePath = runtimePaths.sqlConfirmations;
export const sqlConfirmationTempMaxAgeMs = 10 * 60 * 1000;

function isConfirmation(value: unknown): value is SqlConfirmationRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SqlConfirmationRecord>;
  return [item.id, item.tokenHash, item.datasetId, item.datasetSha256, item.query, item.querySha256, item.expiresAt]
    .every((field) => typeof field === "string");
}

function cleanStaleTemporaryFiles(storePath: string, now: number) {
  const directory = dirname(storePath);
  if (!existsSync(directory)) return 0;
  ensurePrivateDirectory(directory);
  const prefix = `${basename(storePath)}.`;
  let removed = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.name.startsWith(prefix) || !entry.name.endsWith(".tmp")) continue;
    const identifier = entry.name.slice(prefix.length, -4);
    if (!/^[a-f0-9-]{36}$/i.test(identifier)) continue;
    const path = resolve(directory, entry.name);
    const status = lstatSync(path);
    if (status.isSymbolicLink() || !status.isFile()) continue;
    if (now - status.mtimeMs < sqlConfirmationTempMaxAgeMs) continue;
    unlinkSync(path);
    removed += 1;
  }
  return removed;
}

function parseStore(storePath: string): SqlConfirmationRecord[] {
  if (!existsSync(/* turbopackIgnore: true */ storePath)) return [];
  ensurePrivateFile(storePath);
  const value: unknown = JSON.parse(readFileSync(/* turbopackIgnore: true */ storePath, "utf8"));
  if (!Array.isArray(value) || !value.every(isConfirmation)) {
    throw new Error("The local SQL confirmation store is damaged.");
  }
  return value;
}

export function writeSqlConfirmationStore(storePath: string, items: SqlConfirmationRecord[]) {
  ensurePrivateDirectory(/* turbopackIgnore: true */ dirname(storePath));
  const temporary = `${storePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(/* turbopackIgnore: true */ temporary, `${JSON.stringify(items, null, 2)}\n`, { mode: 0o600 });
    ensurePrivateFile(temporary);
    // Windows requires a write-capable handle for FlushFileBuffers/fsync.
    // The bytes are already complete; r+ preserves them while keeping the
    // durability barrier equivalent across supported platforms.
    const descriptor = openSync(temporary, "r+");
    try { fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
    renameSync(/* turbopackIgnore: true */ temporary, storePath);
    ensurePrivateFile(storePath);
  } catch (error) {
    if (existsSync(temporary)) {
      const status = lstatSync(temporary);
      if (!status.isSymbolicLink() && status.isFile()) unlinkSync(temporary);
    }
    throw error;
  }
}

export function maintainSqlConfirmationStoreAtPath(storePath: string, now = Date.now()) {
  const temporaryFilesRemoved = cleanStaleTemporaryFiles(storePath, now);
  const items = parseStore(storePath);
  const active = items.filter((item) => {
    const expiresAt = Date.parse(item.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt > now;
  });
  const expiredConfirmationsRemoved = items.length - active.length;
  if (expiredConfirmationsRemoved > 0) writeSqlConfirmationStore(storePath, active);
  return { items: active, expiredConfirmationsRemoved, temporaryFilesRemoved };
}
