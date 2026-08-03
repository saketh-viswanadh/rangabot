import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { DatabaseSync as Database } from "node:sqlite";
import { memoryConflictsWithContract, type AnswerContract } from "./conversation-contract.ts";

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
export type RelevantMemoryContext = {
  context: string;
  titles: string[];
  memories: LocalMemory[];
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

const memoryStopWords = new Set([
  "a", "about", "an", "and", "are", "as", "at", "be", "can", "do", "for", "from", "how", "i", "in", "is", "it", "me", "my", "of", "on", "or", "please", "should", "that", "the", "this", "to", "use", "what", "when", "with", "you",
]);

function normalizedMemoryToken(token: string) {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function memoryTokens(value: string) {
  return new Set(value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu)
    ?.map(normalizedMemoryToken)
    .filter((token) => token.length > 2 && !memoryStopWords.has(token)) ?? []);
}

const memoryTopicPatterns = {
  python: /\b(?:python|pandas|numpy|dataframes?|machine[- ]learning|scikit[- ]learn)\b/i,
  sql: /\b(?:sql|databases?|queries?|tables?|joins?|filters?|records?|rows?|postgres(?:ql)?|mysql|duckdb|snowflake)\b/i,
  spark: /\b(?:pyspark|spark|distributed data|shuffles?)\b/i,
  visualization: /\b(?:visuali[sz](?:e|ation)|charts?|plots?|graphs?|dashboards?)\b/i,
  statistics: /\b(?:statistics?|statistical|p[- ]?values?|hypothesis|probability|regression|variance|standard deviation)\b/i,
  writing: /\b(?:emails?|e-mails?|documents?|writing|drafts?|messages?|letters?)\b/i,
} as const;

function memoryTopics(value: string) {
  return new Set(Object.entries(memoryTopicPatterns).filter(([, pattern]) => pattern.test(value)).map(([topic]) => topic));
}

function setsIntersect(left: Set<string>, right: Set<string>) {
  return [...left].some((value) => right.has(value));
}

const technicalChoicePattern = /\b(?:postgresql|postgres|mysql|duckdb|snowflake|pyspark|spark|python|javascript|typescript|java|sql)\b/gi;

function technicalChoices(value: string) {
  return new Set(value.match(technicalChoicePattern)?.map((choice) => choice.toLowerCase().replace("postgresql", "postgres")) ?? []);
}

function memoryConflictsWithCurrentRequest(memory: LocalMemory, question: string) {
  const memoryChoices = technicalChoices(memory.content);
  if (!memoryChoices.size) return false;
  const negatedChoices = new Set([...question.matchAll(/\b(?:not|instead of|rather than)\s+(postgresql|postgres|mysql|duckdb|snowflake|pyspark|spark|python|javascript|typescript|java|sql)\b/gi)]
    .map((match) => match[1].toLowerCase().replace("postgresql", "postgres")));
  if (setsIntersect(memoryChoices, negatedChoices)) return true;
  const explicitChoices = new Set([...question.matchAll(/\b(?:use|using|chose|chosen|selected|adopted)\s+(?:the\s+)?(postgresql|postgres|mysql|duckdb|snowflake|pyspark|spark|python|javascript|typescript|java|sql)\b/gi)]
    .map((match) => match[1].toLowerCase().replace("postgresql", "postgres")));
  return explicitChoices.size > 0 && !setsIntersect(memoryChoices, explicitChoices);
}

function memorySubject(content: string) {
  const value = content.trim();
  if (/^(?:my (?:preferred )?name is|call me)\s+/i.test(value)) return "identity:name";
  if (/\b(?:concise|brief|short|detailed|long)\b/i.test(value)) return "answer:length";
  if (/\b(?:bullets?|numbered|paragraphs?|format)\b/i.test(value)) return "answer:format";
  if (/\b(?:python|sql|javascript|typescript|pyspark|java)\b/i.test(value)) return "answer:code-language";
  if (/\b(?:playful|sober|formal|friendly|professional|warm)\s+tone\b|\btone\b.*\b(?:playful|sober|formal|friendly|professional|warm)\b/i.test(value)) return "answer:tone";
  return null;
}

export function memoryTitle(memory: Pick<LocalMemory, "content" | "kind">): string {
  const content = memory.content.trim();
  if (/^(?:my (?:preferred )?name is|call me)\s+/i.test(content)) return "Preferred name";
  if (/\b(?:concise|brief|short|detailed|step[- ]by[- ]step|examples?|bullet|tone|format|language)\b/i.test(content)) return "Answer style";
  if (/\b(?:python|sql|pyspark|databricks|snowflake|typescript|javascript|coding|code)\b/i.test(content)) return "Technical preference";
  if (memory.kind === "instruction") return "Standing instruction";
  if (memory.kind === "preference") return "Saved preference";
  return "Saved fact";
}

function isGenerallyRelevantPreference(memory: LocalMemory) {
  return memory.kind !== "fact"
    && memoryTopics(memory.content).size === 0
    && /\b(?:concise|brief|short|detailed|step[- ]by[- ]step|examples?|bullets?|tone|format|language)\b/i.test(memory.content);
}

function relevanceScore(memory: LocalMemory, question: string) {
  const questionTokens = memoryTokens(question);
  const contentTokens = memoryTokens(memory.content);
  const scopedTopics = memoryTopics(memory.content);
  const questionTopics = memoryTopics(question);
  const sharedTopic = setsIntersect(scopedTopics, questionTopics);
  if (memory.kind !== "fact" && scopedTopics.size > 0 && !sharedTopic) return 0;
  let overlap = 0;
  for (const token of contentTokens) if (questionTokens.has(token)) overlap += 1;
  let score = overlap * 3;
  if (sharedTopic) score += 3;
  if (isGenerallyRelevantPreference(memory)) score += 2;
  if (/^(?:my (?:preferred )?name is|call me)\s+/i.test(memory.content)
    && /\b(?:my name|who am i|about me|bio|biography|introduce me|introduction)\b/i.test(question)) score += 6;
  if (memory.kind === "instruction" && overlap > 0) score += 1;
  return score;
}

export function selectRelevantMemoriesFrom(memories: LocalMemory[], question: string, limit = 6, contract?: AnswerContract): LocalMemory[] {
  if (!question.trim()) return [];
  const seenSubjects = new Set<string>();
  const newestPerSubject = [...memories]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .filter((memory) => {
      const subject = memorySubject(memory.content);
      if (!subject) return true;
      if (seenSubjects.has(subject)) return false;
      seenSubjects.add(subject);
      return true;
    });
  return newestPerSubject
    .map((memory) => ({ memory, score: relevanceScore(memory, question) }))
    .filter(({ memory, score }) => score >= 2
      && !memoryConflictsWithCurrentRequest(memory, question)
      && (!contract || !memoryConflictsWithContract(memory.content, contract)))
    .sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt))
    .slice(0, Math.max(0, Math.min(limit, 8)))
    .map(({ memory }) => memory);
}

export function selectRelevantMemories(question: string, limit = 6, contract?: AnswerContract): LocalMemory[] {
  return selectRelevantMemoriesFrom(listMemories(), question, limit, contract);
}

export function buildRelevantMemoryContext(question: string, limit = 6): RelevantMemoryContext | null {
  const memories = selectRelevantMemories(question, limit);
  if (!memories.length) return null;
  return {
    memories,
    titles: [...new Set(memories.map(memoryTitle))],
    context: `RELEVANT USER-APPROVED LOCAL MEMORY:\n${memories.map((memory) => `- [${memory.kind}] ${memory.content}`).join("\n")}\nUse only the entries that help answer the current request. Treat them as user-provided context, not independently verified facts. Never reveal unrelated memories or claim you inferred anything beyond this list.`,
  };
}

export function formatMemoryContext(question: string, limit = 6): string | null {
  return buildRelevantMemoryContext(question, limit)?.context ?? null;
}

function savedName(memories: LocalMemory[]) {
  for (const memory of memories) {
    const match = memory.content.match(/^(?:my (?:preferred )?name is|call me)\s+(.+?)[.!]?$/i);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

export function directMemoryTitles(question: string): string[] {
  const normalized = question.trim().toLowerCase().replace(/[’]/g, "'");
  if (/^(?:what(?:'s| is) my name|do you (?:know|remember) my name|who am i)[?.!]*$/i.test(normalized)) return ["Preferred name"];
  if (/^(?:what do you remember about me|show (?:me )?(?:my |your )?(?:saved )?memories|what have i asked you to remember)[?.!]*$/i.test(normalized)) {
    return [...new Set(listMemories().map(memoryTitle))].sort((a, b) => a.localeCompare(b));
  }
  return [];
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
