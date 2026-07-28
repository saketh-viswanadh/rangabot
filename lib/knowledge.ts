import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, resolve } from "node:path";
import type { DatabaseSync as Database } from "node:sqlite";

const serverRequire = createRequire(resolve(process.cwd(), "package.json"));
const { DatabaseSync } = serverRequire("node:sqlite") as typeof import("node:sqlite");

export const knowledgeRoot = resolve(process.cwd(), "data", "knowledge");
export const knowledgeInbox = resolve(knowledgeRoot, "inbox");
export const knowledgeDatabasePath = resolve(knowledgeRoot, "indexes", "knowledge.db");
let activeKnowledgeDatabasePath = knowledgeDatabasePath;
export const knowledgeBudgetBytes = Number(process.env.KNOWLEDGE_BUDGET_BYTES ?? 4 * 1024 ** 3);
export const embeddingModel = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";

let database: Database | undefined;

function getDatabase() {
  if (database) return database;
  mkdirSync(resolve(knowledgeRoot, "indexes"), { recursive: true });
  database = new DatabaseSync(activeKnowledgeDatabasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      path TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      format TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      chunk_count INTEGER NOT NULL,
      ingested_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding TEXT,
      FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      chunk_id UNINDEXED,
      document_id UNINDEXED,
      title,
      content,
      tokenize = 'porter unicode61'
    );
  `);
  return database;
}

export type KnowledgeChunkInput = { id: string; ordinal: number; content: string; embedding?: number[] };
export type KnowledgeDocumentInput = { id: string; path: string; title: string; format: string; sizeBytes: number; sha256: string; chunks: KnowledgeChunkInput[] };
export type KnowledgeResult = { title: string; path: string; chunk: number; content: string; score: number };
type SourceManifest = { sources?: Array<{ title?: string; subject?: string[]; difficulty?: string }> };

export function isKnowledgeCatalogQuestion(question: string) {
  return /\b(what|which|list|show)\b.{0,35}\b(teach|learn|subjects?|topics?|knowledge|courses?)\b|\b(teach|learn)\b.{0,20}\b(available|cover|know)\b/i.test(question);
}

export function buildKnowledgeCatalogAnswer() {
  const manifest = readSourceManifest() as SourceManifest;
  const status = getKnowledgeStatus();
  const subjects = [...new Set(manifest.sources?.flatMap((source) => source.subject ?? []) ?? [])];
  const titles = manifest.sources?.map((source) => source.title).filter(Boolean) ?? [];
  const label = (value: string) => value.replaceAll("-", " ").replace(/\b\w/g, (character) => character.toUpperCase());
  return `# What I can teach from the local vault

I currently have **${status.documents} local documents** split into **${status.chunks.toLocaleString()} searchable teaching passages**.

## Available subjects

${subjects.map((subject) => `- ${label(subject)}`).join("\n")}

## Current source collections

${titles.map((title) => `- ${title}`).join("\n")}

I can explain concepts at beginner or detailed level, build examples, compare interpretations, create quizzes, and answer follow-up questions using these sources. For history and mythology, I will distinguish different versions and flag dated interpretations.

My coverage is limited to what has been indexed locally. Add more textbooks to the Knowledge Vault and run \`npm run knowledge:ingest\` to expand what I can teach.`;
}

export function hashBuffer(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function existingDocumentHash(path: string): string | null {
  const row = getDatabase().prepare("SELECT sha256 FROM documents WHERE path = ?").get(path) as { sha256: string } | undefined;
  return row?.sha256 ?? null;
}

export function saveKnowledgeDocument(document: KnowledgeDocumentInput) {
  const db = getDatabase();
  db.exec("BEGIN");
  try {
    const prior = db.prepare("SELECT id FROM documents WHERE path = ?").get(document.path) as { id: string } | undefined;
    if (prior) {
      db.prepare("DELETE FROM chunks_fts WHERE document_id = ?").run(prior.id);
      db.prepare("DELETE FROM chunks WHERE document_id = ?").run(prior.id);
      db.prepare("DELETE FROM documents WHERE id = ?").run(prior.id);
    }
    db.prepare(`INSERT INTO documents (id, path, title, format, size_bytes, sha256, chunk_count, ingested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(document.id, document.path, document.title, document.format, document.sizeBytes, document.sha256, document.chunks.length, new Date().toISOString());
    const insertChunk = db.prepare("INSERT INTO chunks (id, document_id, ordinal, content, embedding) VALUES (?, ?, ?, ?, ?)");
    const insertFts = db.prepare("INSERT INTO chunks_fts (chunk_id, document_id, title, content) VALUES (?, ?, ?, ?)");
    for (const chunk of document.chunks) {
      insertChunk.run(chunk.id, document.id, chunk.ordinal, chunk.content, chunk.embedding ? JSON.stringify(chunk.embedding) : null);
      insertFts.run(chunk.id, document.id, document.title, chunk.content);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function ftsQuery(query: string) {
  return query.normalize("NFKC").match(/[\p{L}\p{N}_-]{2,}/gu)?.slice(0, 12).map((term) => `"${term.replaceAll('"', '')}"`).join(" OR ") ?? "";
}

export async function searchKnowledge(query: string, limit = 6): Promise<KnowledgeResult[]> {
  const expression = ftsQuery(query);
  if (!expression) return [];
  const rows = getDatabase().prepare(`
    SELECT d.title, d.path, c.ordinal AS chunk, c.content, bm25(chunks_fts) AS rank
    FROM chunks_fts
    JOIN chunks c ON c.id = chunks_fts.chunk_id
    JOIN documents d ON d.id = chunks_fts.document_id
    WHERE chunks_fts MATCH ?
    ORDER BY rank LIMIT ?
  `).all(expression, limit) as unknown as Array<Omit<KnowledgeResult, "score"> & { rank: number }>;
  const lexical = rows.map(({ rank, ...row }) => ({ ...row, score: 1 / (1 + Math.max(0, rank)) }));
  const queryEmbedding = process.env.KNOWLEDGE_DISABLE_EMBEDDINGS === "1" ? null : await embedQuery(query);
  if (!queryEmbedding) return lexical;
  const embeddedRows = getDatabase().prepare(`
    SELECT d.title, d.path, c.ordinal AS chunk, c.content, c.embedding
    FROM chunks c JOIN documents d ON d.id = c.document_id
    WHERE c.embedding IS NOT NULL
  `).all() as unknown as Array<Omit<KnowledgeResult, "score"> & { embedding: string }>;
  const semantic = embeddedRows.map(({ embedding, ...row }) => ({ ...row, score: cosine(queryEmbedding, JSON.parse(embedding) as number[]) }))
    .sort((a, b) => b.score - a.score).slice(0, limit * 2);
  const combined = new Map<string, KnowledgeResult>();
  for (const result of lexical) combined.set(`${result.path}:${result.chunk}`, { ...result, score: result.score * .55 });
  for (const result of semantic) {
    const key = `${result.path}:${result.chunk}`;
    const prior = combined.get(key);
    combined.set(key, { ...result, score: result.score * .45 + (prior?.score ?? 0) });
  }
  return [...combined.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

async function embedQuery(input: string): Promise<number[] | null> {
  try {
    const response = await fetch("http://127.0.0.1:11434/api/embed", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: embeddingModel, input }) });
    if (!response.ok) return null;
    return ((await response.json()) as { embeddings?: number[][] }).embeddings?.[0] ?? null;
  } catch { return null; }
}

function cosine(left: number[], right: number[]) {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0; let leftNorm = 0; let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]; leftNorm += left[index] ** 2; rightNorm += right[index] ** 2;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm) || 1);
}

function directorySize(path: string): number {
  try {
    return readdirSync(path, { withFileTypes: true }).reduce((total, entry) => {
      const child = resolve(path, entry.name);
      return total + (entry.isDirectory() ? directorySize(child) : statSync(child).size);
    }, 0);
  } catch {
    return 0;
  }
}

export function getKnowledgeStatus() {
  mkdirSync(knowledgeInbox, { recursive: true });
  const db = getDatabase();
  const documents = db.prepare("SELECT COUNT(*) AS count FROM documents").get() as { count: number };
  const chunks = db.prepare("SELECT COUNT(*) AS count FROM chunks").get() as { count: number };
  const usedBytes = directorySize(knowledgeRoot);
  return { root: knowledgeRoot, inbox: knowledgeInbox, budgetBytes: knowledgeBudgetBytes, usedBytes, remainingBytes: Math.max(0, knowledgeBudgetBytes - usedBytes), documents: documents.count, chunks: chunks.count, embeddingModel };
}

export function listInboxFiles() {
  mkdirSync(knowledgeInbox, { recursive: true });
  const supported = new Set([".pdf", ".docx", ".txt", ".md", ".markdown", ".html", ".htm"]);
  return readdirSync(knowledgeInbox, { withFileTypes: true })
    .filter((entry) => entry.isFile() && supported.has(extname(entry.name).toLowerCase()))
    .map((entry) => resolve(knowledgeInbox, entry.name));
}

export function readSourceManifest() {
  const path = resolve(knowledgeRoot, "SOURCE_MANIFEST.json");
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function closeKnowledgeDatabaseForTests() {
  database?.close();
  database = undefined;
}

export function setKnowledgeDatabasePathForTests(path: string) {
  closeKnowledgeDatabaseForTests();
  activeKnowledgeDatabasePath = path;
}
