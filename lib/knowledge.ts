import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, resolve } from "node:path";
import type { DatabaseSync as Database } from "node:sqlite";

const serverRequire = createRequire(resolve(process.cwd(), "package.json"));
const { DatabaseSync } = serverRequire("node:sqlite") as typeof import("node:sqlite");

export const knowledgeRoot = resolve(process.cwd(), "data", "knowledge");
export const knowledgeInbox = resolve(knowledgeRoot, "inbox");
export const knowledgeWeeklyBrief = resolve(knowledgeRoot, "NEW_THIS_WEEK.md");
export const knowledgeMonthlyBrief = resolve(knowledgeRoot, "NEW_THIS_MONTH.md");
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
    CREATE TABLE IF NOT EXISTS source_issues (
      path TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL,
      reason TEXT NOT NULL,
      detected_at TEXT NOT NULL
    );
  `);
  return database;
}

export type KnowledgeChunkInput = { id: string; ordinal: number; content: string; embedding?: number[] };
export type KnowledgeDocumentInput = { id: string; path: string; title: string; format: string; sizeBytes: number; sha256: string; chunks: KnowledgeChunkInput[] };
export type KnowledgeResult = { title: string; path: string; chunk: number; content: string; score: number };
export type IndexedKnowledgeDocument = { id: string; path: string; title: string; sha256: string; chunkCount: number };
export type KnowledgeSourceState = { name: string; status: "indexed" | "pending" | "incompatible"; detail: string; chunks: number };
type SourceManifest = { sources?: Array<{ title?: string; subject?: string[]; difficulty?: string }> };

export function isKnowledgeCatalogQuestion(question: string) {
  return /\b(what|which|list|show)\b.{0,35}\b(teach|learn|subjects?|topics?|knowledge|courses?)\b|\b(teach|learn)\b.{0,20}\b(available|cover|know)\b/i.test(question);
}

export function isKnowledgeNewsQuestion(question: string) {
  return /\b(what(?:'s| is)? new|latest|recent|new developments?|this (?:week|month)|current (?:news|developments?|updates?))\b/i.test(question);
}

export function shouldAutoSearchKnowledge(question: string) {
  const normalized = question.trim();
  if (normalized.length < 8) return false;
  if (/^(hi|hello|hey|thanks|thank you|good (?:morning|afternoon|evening))[!. ]*$/i.test(normalized)) return false;
  return /\?|^(?:what|why|when|where|who|which|how|explain|define|compare|summarize|teach|tell me about|help me understand)\b/i.test(normalized)
    || /\b(?:python|numpy|pandas|sql|spark|pyspark|databricks|snowflake|data science|machine learning|\bai\b|models?|statistics|visuali[sz]ation|history|mythology|algorithm)\b/i.test(normalized);
}

export function buildKnowledgeNewsAnswer(question: string) {
  const wantsMonth = /\b(month|monthly|july)\b/i.test(question);
  const path = wantsMonth ? knowledgeMonthlyBrief : knowledgeWeeklyBrief;
  const period = wantsMonth ? "monthly" : "weekly";
  try {
    return `${readFileSync(path, "utf8").trim()}\n\n---\nThis is Rangabot's locally saved ${period} subject brief. Source links identify where each development was verified; items marked **indexed** can also be explored offline in Teacher Mode.`;
  } catch {
    return `No ${period} subject brief has been saved locally yet. The vault updater should only create one after finding a meaningful, source-verified development.`;
  }
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

export function relinkKnowledgeDocumentByHash(input: { path: string; title: string; format: string; sizeBytes: number; sha256: string }) {
  const db = getDatabase();
  const row = db.prepare("SELECT id, path FROM documents WHERE sha256 = ? LIMIT 1").get(input.sha256) as { id: string; path: string } | undefined;
  if (!row || row.path === input.path) return false;
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE documents SET path = ?, title = ?, format = ?, size_bytes = ? WHERE id = ?")
      .run(input.path, input.title, input.format, input.sizeBytes, row.id);
    db.prepare("UPDATE chunks_fts SET title = ? WHERE document_id = ?").run(input.title, row.id);
    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function listIndexedKnowledgeDocuments(): IndexedKnowledgeDocument[] {
  return getDatabase().prepare("SELECT id, path, title, sha256, chunk_count AS chunkCount FROM documents ORDER BY title")
    .all() as unknown as IndexedKnowledgeDocument[];
}

export function removeKnowledgeDocumentsNotIn(activePaths: string[]) {
  const db = getDatabase();
  const active = new Set(activePaths);
  const stale = listIndexedKnowledgeDocuments().filter((document) => !active.has(document.path));
  if (!stale.length) return [];
  db.exec("BEGIN");
  try {
    for (const document of stale) {
      db.prepare("DELETE FROM chunks_fts WHERE document_id = ?").run(document.id);
      db.prepare("DELETE FROM chunks WHERE document_id = ?").run(document.id);
      db.prepare("DELETE FROM documents WHERE id = ?").run(document.id);
    }
    db.exec("COMMIT");
    return stale.map((document) => document.path);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function removeKnowledgeDocumentByPath(path: string) {
  const db = getDatabase();
  const row = db.prepare("SELECT id FROM documents WHERE path = ?").get(path) as { id: string } | undefined;
  if (!row) return false;
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM chunks_fts WHERE document_id = ?").run(row.id);
    db.prepare("DELETE FROM chunks WHERE document_id = ?").run(row.id);
    db.prepare("DELETE FROM documents WHERE id = ?").run(row.id);
    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function recordKnowledgeSourceIssue(path: string, sha256: string, reason: string) {
  getDatabase().prepare(`INSERT INTO source_issues (path, sha256, reason, detected_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET sha256 = excluded.sha256, reason = excluded.reason, detected_at = excluded.detected_at`)
    .run(path, sha256, reason, new Date().toISOString());
}

export function clearKnowledgeSourceIssue(path: string) {
  getDatabase().prepare("DELETE FROM source_issues WHERE path = ?").run(path);
}

export function removeKnowledgeSourceIssuesNotIn(activePaths: string[]) {
  const active = new Set(activePaths);
  const rows = getDatabase().prepare("SELECT path FROM source_issues").all() as unknown as Array<{ path: string }>;
  for (const row of rows) if (!active.has(row.path)) getDatabase().prepare("DELETE FROM source_issues WHERE path = ?").run(row.path);
}

export function getKnowledgeSourceStates(): KnowledgeSourceState[] {
  const indexed = new Map(listIndexedKnowledgeDocuments().map((document) => [document.path, document]));
  const issues = new Map((getDatabase().prepare("SELECT path, reason FROM source_issues").all() as unknown as Array<{ path: string; reason: string }>).map((issue) => [issue.path, issue.reason]));
  return listKnowledgeFiles().map((path) => {
    const document = indexed.get(path);
    if (document) return { name: path.split("/").at(-1) ?? path, status: "indexed" as const, detail: `${document.chunkCount} searchable passages`, chunks: document.chunkCount };
    const issue = issues.get(path);
    if (issue) return { name: path.split("/").at(-1) ?? path, status: "incompatible" as const, detail: issue, chunks: 0 };
    return { name: path.split("/").at(-1) ?? path, status: "pending" as const, detail: "Run npm run knowledge:ingest", chunks: 0 };
  }).sort((left, right) => left.status.localeCompare(right.status) || left.name.localeCompare(right.name));
}

export function indexedDocumentUsefulCharacters(path: string) {
  const rows = getDatabase().prepare(`SELECT c.content FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path = ? ORDER BY c.ordinal`)
    .all(path) as unknown as Array<{ content: string }>;
  return rows.map((row) => row.content).join(" ").replace(/\[Page\s+\d+\]/gi, "").match(/[\p{L}\p{N}]/gu)?.length ?? 0;
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

const queryStopWords = new Set(["a", "all", "an", "and", "are", "about", "can", "could", "do", "does", "explain", "for", "from", "give", "how", "i", "in", "is", "it", "me", "of", "on", "please", "tell", "the", "to", "what", "when", "where", "which", "who", "why", "with", "would", "you"]);

export function knowledgeQueryTerms(query: string) {
  const terms = query.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  return [...new Set(terms.filter((term) => !queryStopWords.has(term)))].slice(0, 12);
}

function ftsQuery(query: string) {
  return knowledgeQueryTerms(query).map((term) => `"${term.replaceAll('"', '')}"`).join(" OR ");
}

export async function searchKnowledge(query: string, limit = 6): Promise<KnowledgeResult[]> {
  const expression = ftsQuery(query);
  if (!expression) return [];
  const terms = knowledgeQueryTerms(query);
  const rows = getDatabase().prepare(`
    SELECT d.title, d.path, c.ordinal AS chunk, c.content, bm25(chunks_fts, 8.0, 1.0) AS rank
    FROM chunks_fts
    JOIN chunks c ON c.id = chunks_fts.chunk_id
    JOIN documents d ON d.id = chunks_fts.document_id
    WHERE chunks_fts MATCH ?
    ORDER BY rank LIMIT ?
  `).all(expression, Math.max(limit * 6, 24)) as unknown as Array<Omit<KnowledgeResult, "score"> & { rank: number }>;
  const lexical = rows.map(({ rank: _rank, ...row }, index) => ({ ...row, lexicalScore: Math.max(.35, 1 - index / Math.max(rows.length, 1)) }));
  const queryEmbedding = process.env.KNOWLEDGE_DISABLE_EMBEDDINGS === "1" ? null : await embedQuery(query);
  if (!queryEmbedding) return lexical.slice(0, limit).map(({ lexicalScore, ...result }) => ({ ...result, score: lexicalScore }));
  const embeddedRows = getDatabase().prepare(`
    SELECT d.title, d.path, c.ordinal AS chunk, c.content, c.embedding
    FROM chunks c JOIN documents d ON d.id = c.document_id
    WHERE c.embedding IS NOT NULL
  `).all() as unknown as Array<Omit<KnowledgeResult, "score"> & { embedding: string }>;
  const semantic = embeddedRows.map(({ embedding, ...row }) => ({ ...row, similarity: cosine(queryEmbedding, JSON.parse(embedding) as number[]) }))
    .sort((a, b) => b.similarity - a.similarity).slice(0, Math.max(limit * 6, 24));
  const combined = new Map<string, KnowledgeResult & { lexical?: boolean; similarity?: number }>();
  for (const result of lexical) {
    const title = result.title.toLowerCase();
    const titleBoost = terms.some((term) => title.includes(term)) ? .35 : 0;
    combined.set(`${result.path}:${result.chunk}`, { title: result.title, path: result.path, chunk: result.chunk, content: result.content, score: result.lexicalScore * .68 + titleBoost, lexical: true });
  }
  for (const result of semantic) {
    const key = `${result.path}:${result.chunk}`;
    const prior = combined.get(key);
    if (!prior && result.similarity < .46) continue;
    combined.set(key, { title: result.title, path: result.path, chunk: result.chunk, content: result.content, score: (prior?.score ?? 0) + result.similarity * .32, lexical: prior?.lexical, similarity: result.similarity });
  }
  return [...combined.values()]
    .filter((result) => result.lexical || (result.similarity ?? 0) >= .46)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ lexical: _lexical, similarity: _similarity, ...result }) => result);
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
  const sources = getKnowledgeSourceStates();
  return { root: knowledgeRoot, inbox: knowledgeInbox, budgetBytes: knowledgeBudgetBytes, usedBytes, remainingBytes: Math.max(0, knowledgeBudgetBytes - usedBytes), documents: documents.count, chunks: chunks.count, embeddingModel, sources, incompatible: sources.filter((source) => source.status === "incompatible").length, pending: sources.filter((source) => source.status === "pending").length };
}

export function listInboxFiles() {
  mkdirSync(knowledgeInbox, { recursive: true });
  const supported = new Set([".pdf", ".docx", ".txt", ".md", ".markdown", ".html", ".htm"]);
  return readdirSync(knowledgeInbox, { withFileTypes: true })
    .filter((entry) => entry.isFile() && supported.has(extname(entry.name).toLowerCase()))
    .map((entry) => resolve(knowledgeInbox, entry.name));
}

export function listKnowledgeFiles() {
  return [...listInboxFiles(), ...[knowledgeWeeklyBrief, knowledgeMonthlyBrief].filter((path) => {
    try { return statSync(path).isFile(); } catch { return false; }
  })];
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
