import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { DatabaseSync as Database } from "node:sqlite";

const serverRequire = createRequire(resolve(process.cwd(), "package.json"));
const { DatabaseSync } = serverRequire("node:sqlite") as typeof import("node:sqlite");

export type MemoryKind = "preference" | "fact" | "instruction";
export type LocalMemory = {
  id: string;
  content: string;
  kind: MemoryKind;
  origin: "user-approved";
  confidence: 1;
  createdAt: string;
  updatedAt: string;
};

const defaultDatabasePath = resolve(process.cwd(), "data", "rangabot-memory.db");
let databasePath = defaultDatabasePath;
let database: Database | undefined;

function getDatabase() {
  if (database) return database;
  mkdirSync(dirname(databasePath), { recursive: true });
  database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('preference', 'fact', 'instruction')),
      origin TEXT NOT NULL DEFAULT 'user-approved',
      confidence REAL NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return database;
}

type MemoryRow = { id: string; content: string; kind: MemoryKind; origin: "user-approved"; confidence: number; createdAt: string; updatedAt: string };

function fromRow(row: MemoryRow): LocalMemory {
  return { ...row, confidence: 1 };
}

export function validateMemoryInput(content: unknown, kind: unknown): { content: string; kind: MemoryKind } {
  if (typeof content !== "string" || !content.trim() || content.trim().length > 500) throw new Error("Memory must contain 1–500 characters.");
  if (kind !== "preference" && kind !== "fact" && kind !== "instruction") throw new Error("Memory kind is invalid.");
  return { content: content.trim(), kind };
}

export function listMemories(): LocalMemory[] {
  return (getDatabase().prepare(`SELECT id, content, kind, origin, confidence, created_at AS createdAt, updated_at AS updatedAt FROM memories ORDER BY updated_at DESC`).all() as unknown as MemoryRow[]).map(fromRow);
}

export function createMemory(content: string, kind: MemoryKind): LocalMemory {
  const valid = validateMemoryInput(content, kind);
  const now = new Date().toISOString();
  const memory: LocalMemory = { id: randomUUID(), ...valid, origin: "user-approved", confidence: 1, createdAt: now, updatedAt: now };
  getDatabase().prepare("INSERT INTO memories (id, content, kind, origin, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(memory.id, memory.content, memory.kind, memory.origin, memory.confidence, memory.createdAt, memory.updatedAt);
  return memory;
}

export function updateMemory(id: string, content: string, kind: MemoryKind): LocalMemory | null {
  const valid = validateMemoryInput(content, kind);
  const updatedAt = new Date().toISOString();
  const result = getDatabase().prepare("UPDATE memories SET content = ?, kind = ?, updated_at = ? WHERE id = ?").run(valid.content, valid.kind, updatedAt, id);
  if (!result.changes) return null;
  const row = getDatabase().prepare("SELECT id, content, kind, origin, confidence, created_at AS createdAt, updated_at AS updatedAt FROM memories WHERE id = ?").get(id) as unknown as MemoryRow;
  return fromRow(row);
}

export function deleteMemory(id: string): boolean {
  return getDatabase().prepare("DELETE FROM memories WHERE id = ?").run(id).changes > 0;
}

export function formatMemoryContext(limit = 20): string | null {
  const memories = listMemories().slice(0, Math.max(0, Math.min(limit, 20)));
  if (!memories.length) return null;
  return `USER-APPROVED LOCAL MEMORY:\n${memories.map((memory) => `- [${memory.kind}] ${memory.content}`).join("\n")}\nUse these only when relevant. Treat them as user-provided context, not independently verified facts. Never claim you inferred or learned anything beyond this list.`;
}

export function exportMemoriesJson(exportedAt = new Date().toISOString()): string {
  return `${JSON.stringify({ version: 1, exportedAt, memories: listMemories() }, null, 2)}\n`;
}

export function closeMemoryDatabaseForTests() { database?.close(); database = undefined; }
export function setMemoryDatabasePathForTests(path: string) { closeMemoryDatabaseForTests(); databasePath = path; }
