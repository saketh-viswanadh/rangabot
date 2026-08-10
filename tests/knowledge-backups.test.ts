import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createKnowledgeBackup,
  getKnowledgeBackupRetention,
  listKnowledgeBackups,
  restoreLatestKnowledgeBackup,
  validateKnowledgeBackup,
} from "../lib/knowledge-backups.ts";
import { privateDirectoryMode, privateFileMode, supportsPosixPermissions } from "../lib/private-storage.ts";
import { acquireRuntimeLease, RuntimeLeaseError } from "../lib/runtime-lease.ts";

function createKnowledgeDatabase(path: string, title: string) {
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE chunks (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, content TEXT NOT NULL);
  `);
  database.prepare("INSERT INTO documents (id, title) VALUES (?, ?)").run("doc-1", title);
  database.prepare("INSERT INTO chunks (id, document_id, content) VALUES (?, ?, ?)").run("chunk-1", "doc-1", `Notes for ${title}`);
  database.close();
}

function updateTitle(path: string, title: string) {
  const database = new DatabaseSync(path);
  database.prepare("UPDATE documents SET title = ? WHERE id = ?").run(title, "doc-1");
  database.close();
}

function readTitle(path: string) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return (database.prepare("SELECT title FROM documents WHERE id = ?").get("doc-1") as { title: string }).title;
  } finally {
    database.close();
  }
}

function permissions(path: string) {
  return statSync(path).mode & 0o777;
}

test("creates private checksummed backups and conservatively prunes only the oldest synthetic copies", async () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-knowledge-backups-"));
  const databasePath = join(root, "indexes", "knowledge.db");
  const backupRoot = join(root, "backups");
  try {
    createKnowledgeDatabase(databasePath, "First");
    const first = await createKnowledgeBackup({ databasePath, backupRoot, retention: 2, now: () => new Date("2026-01-01T00:00:00.000Z") });
    updateTitle(databasePath, "Second");
    const second = await createKnowledgeBackup({ databasePath, backupRoot, retention: 2, now: () => new Date("2026-01-02T00:00:00.000Z") });
    updateTitle(databasePath, "Third");
    const third = await createKnowledgeBackup({ databasePath, backupRoot, retention: 2, now: () => new Date("2026-01-03T00:00:00.000Z") });

    assert.equal(existsSync(first.path), false);
    assert.equal(existsSync(`${first.path}.sha256`), false);
    assert.deepEqual(listKnowledgeBackups(backupRoot).map((item) => item.name), [third.name, second.name]);
    assert.deepEqual(validateKnowledgeBackup(third.path), { sha256: third.sha256, checksumVerified: true });
    if (supportsPosixPermissions()) {
      assert.equal(permissions(backupRoot), privateDirectoryMode);
      for (const path of [second.path, second.checksumPath, third.path, third.checksumPath]) {
        assert.equal(permissions(path), privateFileMode);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("captures committed WAL content through SQLite's online backup API", async () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-knowledge-wal-backup-"));
  const databasePath = join(root, "indexes", "knowledge.db");
  const backupRoot = join(root, "backups");
  let source: DatabaseSync | undefined;
  try {
    createKnowledgeDatabase(databasePath, "Before WAL");
    source = new DatabaseSync(databasePath);
    source.exec("PRAGMA journal_mode = WAL");
    source.prepare("UPDATE documents SET title = ? WHERE id = ?").run("Committed in WAL", "doc-1");

    const result = await createKnowledgeBackup({ databasePath, backupRoot, retention: 4 });

    assert.equal(readTitle(result.path), "Committed in WAL");
    assert.equal(validateKnowledgeBackup(result.path).checksumVerified, true);
  } finally {
    source?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("validates a backup before replacing the live index and preserves a recovery backup", async () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-knowledge-restore-"));
  const databasePath = join(root, "indexes", "knowledge.db");
  const backupRoot = join(root, "backups");
  const runtimeLeasePath = join(root, "runtime.lock");
  try {
    createKnowledgeDatabase(databasePath, "Backed up");
    const target = await createKnowledgeBackup({ databasePath, backupRoot, retention: 4, now: () => new Date("2026-01-01T00:00:00.000Z") });
    updateTitle(databasePath, "Current unsaved state");

    const result = await restoreLatestKnowledgeBackup({
      databasePath,
      backupRoot,
      runtimeLeasePath,
      retention: 4,
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    });

    assert.equal(result.restored, target.name);
    assert.equal(result.checksumVerified, true);
    assert.ok(result.recoveryBackup?.includes("pre-restore"));
    assert.equal(readTitle(databasePath), "Backed up");
    const recovery = listKnowledgeBackups(backupRoot).find((item) => item.name === result.recoveryBackup);
    assert.ok(recovery);
    assert.equal(readTitle(recovery.path), "Current unsaved state");
    assert.equal(existsSync(runtimeLeasePath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses tampered backups without touching the live knowledge index", async () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-knowledge-tamper-"));
  const databasePath = join(root, "indexes", "knowledge.db");
  const backupRoot = join(root, "backups");
  const runtimeLeasePath = join(root, "runtime.lock");
  try {
    createKnowledgeDatabase(databasePath, "Original backup");
    const target = await createKnowledgeBackup({ databasePath, backupRoot, retention: 4 });
    updateTitle(databasePath, "Must remain live");
    writeFileSync(target.path, Buffer.concat([readFileSync(target.path), Buffer.from("tampered") ]));

    await assert.rejects(
      () => restoreLatestKnowledgeBackup({ databasePath, backupRoot, retention: 4, runtimeLeasePath }),
      /checksum validation failed/,
    );
    assert.equal(readTitle(databasePath), "Must remain live");
    assert.equal(existsSync(runtimeLeasePath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses rollback while an app runtime lease is active without touching the live index", async () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-knowledge-active-runtime-"));
  const databasePath = join(root, "indexes", "knowledge.db");
  const backupRoot = join(root, "backups");
  const runtimeLeasePath = join(root, "runtime.lock");
  let runtimeLease: ReturnType<typeof acquireRuntimeLease> | undefined;
  try {
    createKnowledgeDatabase(databasePath, "Backed up");
    await createKnowledgeBackup({ databasePath, backupRoot, retention: 4 });
    updateTitle(databasePath, "Live app state");
    runtimeLease = acquireRuntimeLease({ path: runtimeLeasePath, role: "app" });

    await assert.rejects(
      () => restoreLatestKnowledgeBackup({ databasePath, backupRoot, retention: 4, runtimeLeasePath }),
      (error) => error instanceof RuntimeLeaseError && error.code === "active",
    );
    assert.equal(readTitle(databasePath), "Live app state");
  } finally {
    runtimeLease?.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts structurally valid legacy backups without claiming checksum verification", async () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-knowledge-legacy-"));
  const databasePath = join(root, "indexes", "knowledge.db");
  const backupRoot = join(root, "backups");
  try {
    createKnowledgeDatabase(databasePath, "Legacy");
    const target = await createKnowledgeBackup({ databasePath, backupRoot, retention: 4 });
    unlinkSync(target.checksumPath);
    assert.deepEqual(validateKnowledgeBackup(target.path), { sha256: target.sha256, checksumVerified: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects unsafe retention values before any deletion", () => {
  assert.equal(getKnowledgeBackupRetention(undefined), 12);
  for (const value of ["0", "1", "101", "2.5", "all"]) {
    assert.throws(() => getKnowledgeBackupRetention(value), /whole number from 2 to 100/);
  }
});
