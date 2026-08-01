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
export type MemoryImportItem = { sourceId: string; content: string; kind: MemoryKind };
export type MemoryImportConflict = { incoming: MemoryImportItem; existing: LocalMemory; reason: "same-id" | "different-kind" | "same-subject" };
export type MemoryImportPreview = {
  newItems: MemoryImportItem[];
  duplicates: Array<{ incoming: MemoryImportItem; existing: LocalMemory }>;
  conflicts: MemoryImportConflict[];
};

export const maxMemoryImportBytes = 300_000;
export const maxMemoryImportItems = 200;

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

function savedName(memories: LocalMemory[]) {
  for (const memory of memories) {
    const match = memory.content.match(/^(?:my name is|call me)\s+(.+?)[.!]?$/i);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

export function answerDirectMemoryQuestion(question: string): string | null {
  const normalized = question.trim().toLowerCase().replace(/[’]/g, "'");
  const memories = listMemories();
  if (/^(?:what(?:'s| is) my name|do you (?:know|remember) my name|who am i)[?.!]*$/i.test(normalized)) {
    const name = savedName(memories);
    return name
      ? `Your name is ${name}. You explicitly saved that in Local memory.`
      : "You haven't saved your name in Local memory yet, so I won't guess.";
  }
  if (/^(?:what do you remember about me|show (?:me )?(?:my |your )?(?:saved )?memories|what have i asked you to remember)[?.!]*$/i.test(normalized)) {
    if (!memories.length) return "You haven't approved any Local memory yet.";
    return `You have approved these Local memories:\n${memories.map((memory) => `- **${memory.kind}:** ${memory.content}`).join("\n")}`;
  }
  return null;
}

export function exportMemoriesJson(exportedAt = new Date().toISOString()): string {
  return `${JSON.stringify({ version: 1, exportedAt, memories: listMemories() }, null, 2)}\n`;
}

function normalizedMemoryContent(content: string) {
  return content.normalize("NFKC").trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "").toLowerCase();
}

function memorySubject(content: string) {
  return /^(?:my name is|call me)\s+/i.test(content.trim()) ? "identity:name" : null;
}

export function parseMemoryExport(payload: unknown): MemoryImportItem[] {
  if (!payload || typeof payload !== "object") throw new Error("Choose a Rangabot memory JSON export.");
  const candidate = payload as { version?: unknown; exportedAt?: unknown; memories?: unknown };
  if (candidate.version !== 1 || typeof candidate.exportedAt !== "string" || !Number.isFinite(Date.parse(candidate.exportedAt))) {
    throw new Error("This is not a supported Rangabot memory export.");
  }
  if (!Array.isArray(candidate.memories) || candidate.memories.length > maxMemoryImportItems) {
    throw new Error(`Memory exports may contain at most ${maxMemoryImportItems} items.`);
  }
  const sourceIds = new Set<string>();
  const contents = new Set<string>();
  const subjects = new Set<string>();
  return candidate.memories.map((value) => {
    if (!value || typeof value !== "object") throw new Error("The memory export contains an invalid item.");
    const item = value as Record<string, unknown>;
    if (typeof item.id !== "string" || !item.id.trim() || item.id.length > 80 || item.origin !== "user-approved" || item.confidence !== 1) {
      throw new Error("Every imported memory must have a valid ID and explicit user-approved provenance.");
    }
    const valid = validateMemoryInput(item.content, item.kind);
    const normalized = normalizedMemoryContent(valid.content);
    const subject = memorySubject(valid.content);
    if (sourceIds.has(item.id) || contents.has(normalized) || (subject && subjects.has(subject))) {
      throw new Error("The import file contains duplicate or internally conflicting memories.");
    }
    sourceIds.add(item.id); contents.add(normalized); if (subject) subjects.add(subject);
    return { sourceId: item.id, ...valid };
  });
}

export function previewMemoryImport(payload: unknown): MemoryImportPreview {
  const incoming = parseMemoryExport(payload);
  const existing = listMemories();
  const preview: MemoryImportPreview = { newItems: [], duplicates: [], conflicts: [] };
  for (const item of incoming) {
    const normalized = normalizedMemoryContent(item.content);
    const duplicate = existing.find((memory) => memory.kind === item.kind && normalizedMemoryContent(memory.content) === normalized);
    if (duplicate) { preview.duplicates.push({ incoming: item, existing: duplicate }); continue; }
    const sameId = existing.find((memory) => memory.id === item.sourceId);
    if (sameId) { preview.conflicts.push({ incoming: item, existing: sameId, reason: "same-id" }); continue; }
    const differentKind = existing.find((memory) => memory.kind !== item.kind && normalizedMemoryContent(memory.content) === normalized);
    if (differentKind) { preview.conflicts.push({ incoming: item, existing: differentKind, reason: "different-kind" }); continue; }
    const subject = memorySubject(item.content);
    const sameSubject = subject ? existing.find((memory) => memorySubject(memory.content) === subject) : undefined;
    if (sameSubject) { preview.conflicts.push({ incoming: item, existing: sameSubject, reason: "same-subject" }); continue; }
    preview.newItems.push(item);
  }
  return preview;
}

export function applyMemoryImport(payload: unknown, replaceSourceIds: unknown) {
  if (!Array.isArray(replaceSourceIds) || !replaceSourceIds.every((id) => typeof id === "string")) throw new Error("Import conflict selections are invalid.");
  const preview = previewMemoryImport(payload);
  const replace = new Set(replaceSourceIds);
  const validConflictIds = new Set(preview.conflicts.map((conflict) => conflict.incoming.sourceId));
  if ([...replace].some((id) => !validConflictIds.has(id))) throw new Error("An import selection no longer matches the reviewed conflicts.");
  const db = getDatabase();
  const now = new Date().toISOString();
  db.exec("BEGIN");
  try {
    for (const item of preview.newItems) {
      db.prepare("INSERT INTO memories (id, content, kind, origin, confidence, created_at, updated_at) VALUES (?, ?, ?, 'user-approved', 1, ?, ?)")
        .run(randomUUID(), item.content, item.kind, now, now);
    }
    for (const conflict of preview.conflicts) {
      if (!replace.has(conflict.incoming.sourceId)) continue;
      db.prepare("UPDATE memories SET content = ?, kind = ?, updated_at = ? WHERE id = ?")
        .run(conflict.incoming.content, conflict.incoming.kind, now, conflict.existing.id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return {
    imported: preview.newItems.length,
    replaced: preview.conflicts.filter((conflict) => replace.has(conflict.incoming.sourceId)).length,
    skippedDuplicates: preview.duplicates.length,
    keptExisting: preview.conflicts.filter((conflict) => !replace.has(conflict.incoming.sourceId)).length,
  };
}

export function closeMemoryDatabaseForTests() { database?.close(); database = undefined; }
export function setMemoryDatabasePathForTests(path: string) { closeMemoryDatabaseForTests(); databasePath = path; }
