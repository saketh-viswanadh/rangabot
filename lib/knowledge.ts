import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, resolve } from "node:path";
import type { DatabaseSync as Database } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";
import { getConfiguredEmbeddingModel, getKnowledgeBudgetBytes, getLocalOllamaBaseUrl } from "./local-runtime-config.ts";

const serverRequire = createRequire(resolve(process.cwd(), "package.json"));
const { DatabaseSync } = serverRequire("node:sqlite") as typeof import("node:sqlite");

export const knowledgeRoot = resolve(process.cwd(), "data", "knowledge");
export const knowledgeInbox = resolve(knowledgeRoot, "inbox");
export const knowledgeWeeklyBrief = resolve(knowledgeRoot, "NEW_THIS_WEEK.md");
export const knowledgeMonthlyBrief = resolve(knowledgeRoot, "NEW_THIS_MONTH.md");
export const knowledgeDatabasePath = resolve(knowledgeRoot, "indexes", "knowledge.db");
let activeKnowledgeDatabasePath = knowledgeDatabasePath;
export const knowledgeBudgetBytes = getKnowledgeBudgetBytes();
export const embeddingModel = getConfiguredEmbeddingModel();

let database: Database | undefined;
let nativeVectorAvailable = false;
export const knowledgeIngestionVersion = 2;

function ensureColumn(db: Database, table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function getDatabase() {
  if (database) return database;
  mkdirSync(resolve(knowledgeRoot, "indexes"), { recursive: true });
  database = new DatabaseSync(activeKnowledgeDatabasePath, { allowExtension: true });
  try {
    sqliteVec.load(database);
    database.enableLoadExtension(false);
    nativeVectorAvailable = true;
  } catch {
    nativeVectorAvailable = false;
  }
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
    CREATE INDEX IF NOT EXISTS chunks_document_ordinal_idx ON chunks(document_id, ordinal);
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
    CREATE TABLE IF NOT EXISTS vector_index_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL,
      built_at TEXT NOT NULL
    );
  `);
  ensureColumn(database, "documents", "ingestion_version", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(database, "chunks", "heading", "TEXT");
  ensureColumn(database, "chunks", "section_path", "TEXT");
  ensureColumn(database, "chunks", "page_start", "INTEGER");
  ensureColumn(database, "chunks", "page_end", "INTEGER");
  return database;
}

function vectorBlob(values: number[]) {
  return new Uint8Array(new Float32Array(values).buffer);
}

function nativeVectorTableExists(db: Database) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chunk_vectors'").get());
}

function invalidateNativeVectorIndex(db: Database) {
  if (nativeVectorTableExists(db)) db.exec("DROP TABLE chunk_vectors");
  db.prepare("DELETE FROM vector_index_meta WHERE id = 1").run();
}

export function rebuildKnowledgeVectorIndex() {
  const db = getDatabase();
  if (!nativeVectorAvailable) return { available: false, vectors: 0, dimensions: 0, rebuilt: false };
  const rows = db.prepare("SELECT rowid, embedding FROM chunks WHERE embedding IS NOT NULL ORDER BY rowid").all() as unknown as Array<{ rowid: number; embedding: string }>;
  if (!rows.length) return { available: true, vectors: 0, dimensions: 0, rebuilt: false };
  const dimensions = (JSON.parse(rows[0].embedding) as number[]).length;
  invalidateNativeVectorIndex(db);
  db.exec(`CREATE VIRTUAL TABLE chunk_vectors USING vec0(embedding float[${dimensions}] distance_metric=cosine)`);
  db.exec("BEGIN");
  try {
    const insert = db.prepare("INSERT INTO chunk_vectors(rowid, embedding) VALUES (?, ?)");
    for (const row of rows) insert.run(BigInt(row.rowid), vectorBlob(JSON.parse(row.embedding) as number[]));
    db.prepare("INSERT INTO vector_index_meta (id, model, dimensions, chunk_count, built_at) VALUES (1, ?, ?, ?, ?)")
      .run(embeddingModel, dimensions, rows.length, new Date().toISOString());
    db.exec("COMMIT");
    return { available: true, vectors: rows.length, dimensions, rebuilt: true };
  } catch (error) {
    db.exec("ROLLBACK");
    invalidateNativeVectorIndex(db);
    throw error;
  }
}

export function getKnowledgeVectorIndexStatus() {
  const db = getDatabase();
  const expected = db.prepare("SELECT COUNT(*) AS count FROM chunks WHERE embedding IS NOT NULL").get() as { count: number };
  const meta = db.prepare("SELECT dimensions, chunk_count AS chunkCount, built_at AS builtAt FROM vector_index_meta WHERE id = 1").get() as { dimensions: number; chunkCount: number; builtAt: string } | undefined;
  return { available: nativeVectorAvailable, expected: expected.count, indexed: nativeVectorTableExists(db) ? (meta?.chunkCount ?? 0) : 0, dimensions: meta?.dimensions ?? 0, builtAt: meta?.builtAt ?? null };
}

function ensureNativeVectorIndex(dimensions: number) {
  if (!nativeVectorAvailable) return false;
  const db = getDatabase();
  const expected = db.prepare("SELECT COUNT(*) AS count FROM chunks WHERE embedding IS NOT NULL").get() as { count: number };
  const meta = db.prepare("SELECT model, dimensions, chunk_count AS chunkCount FROM vector_index_meta WHERE id = 1").get() as { model: string; dimensions: number; chunkCount: number } | undefined;
  if (!nativeVectorTableExists(db) || meta?.model !== embeddingModel || meta.dimensions !== dimensions || meta.chunkCount !== expected.count) rebuildKnowledgeVectorIndex();
  return nativeVectorTableExists(db);
}

export type KnowledgeChunkInput = { id: string; ordinal: number; content: string; embedding?: number[]; heading?: string; sectionPath?: string; pageStart?: number; pageEnd?: number };
export type KnowledgeDocumentInput = { id: string; path: string; title: string; format: string; sizeBytes: number; sha256: string; chunks: KnowledgeChunkInput[] };
export type KnowledgeResult = { title: string; path: string; chunk: number; content: string; score: number; heading?: string; sectionPath?: string; pageStart?: number; pageEnd?: number };
export type KnowledgeSearchMode = "hybrid" | "keyword-only";
export type KnowledgeSearchResponse = { results: KnowledgeResult[]; mode: KnowledgeSearchMode };
export type IndexedKnowledgeDocument = { id: string; path: string; title: string; sha256: string; chunkCount: number; ingestionVersion: number };
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
    return `${readFileSync(/* turbopackIgnore: true */ path, "utf8").trim()}\n\n---\nThis is Rangabot's locally saved ${period} subject brief. Source links identify where each development was verified; items marked **indexed** can also be explored offline in Teacher Mode.`;
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

export function existingDocumentIngestionVersion(path: string): number | null {
  const row = getDatabase().prepare("SELECT ingestion_version AS version FROM documents WHERE path = ?").get(path) as { version: number } | undefined;
  return row?.version ?? null;
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
  return getDatabase().prepare("SELECT id, path, title, sha256, chunk_count AS chunkCount, ingestion_version AS ingestionVersion FROM documents ORDER BY title")
    .all() as unknown as IndexedKnowledgeDocument[];
}

export function removeKnowledgeDocumentsNotIn(activePaths: string[]) {
  const db = getDatabase();
  const active = new Set(activePaths);
  const stale = listIndexedKnowledgeDocuments().filter((document) => !active.has(document.path));
  if (!stale.length) return [];
  if (nativeVectorAvailable) invalidateNativeVectorIndex(db);
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
  if (nativeVectorAvailable) invalidateNativeVectorIndex(db);
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
    if (document?.ingestionVersion === knowledgeIngestionVersion) return { name: path.split("/").at(-1) ?? path, status: "indexed" as const, detail: `${document.chunkCount} searchable passages with hierarchy`, chunks: document.chunkCount };
    if (document) return { name: path.split("/").at(-1) ?? path, status: "pending" as const, detail: "Run npm run knowledge:ingest to add chapter and page metadata", chunks: document.chunkCount };
    const issue = issues.get(path);
    if (issue) return { name: path.split("/").at(-1) ?? path, status: "incompatible" as const, detail: issue, chunks: 0 };
    return { name: path.split("/").at(-1) ?? path, status: "pending" as const, detail: "Run npm run knowledge:ingest", chunks: 0 };
  }).sort((left, right) => left.status.localeCompare(right.status) || left.name.localeCompare(right.name));
}

const pageMarkerRemainderSql = `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LOWER(c.content), '[page ', ''), ']', ''), '0', ''), '1', ''), '2', ''), '3', ''), '4', ''), '5', ''), '6', ''), '7', ''), '8', ''), '9', ''), ' ', ''), CHAR(10), ''), CHAR(13), '')`;
const nonWhitespaceLengthSql = `LENGTH(REPLACE(REPLACE(REPLACE(REPLACE(c.content, ' ', ''), CHAR(10), ''), CHAR(13), ''), CHAR(9), ''))`;

export function indexedDocumentUsefulCharacters(path: string) {
  const result = getDatabase().prepare(`
    SELECT COALESCE(SUM(
      CASE
        WHEN LENGTH(${pageMarkerRemainderSql}) = 0 THEN 0
        ELSE ${nonWhitespaceLengthSql}
      END
    ), 0) AS usefulCharacters
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE d.path = ?
  `).get(path) as { usefulCharacters: number };
  return result.usefulCharacters;
}

export function listIndexedDocumentUsefulCharacters() {
  return getDatabase().prepare(`
    SELECT d.path, COALESCE(SUM(
      CASE
        WHEN LENGTH(${pageMarkerRemainderSql}) = 0 THEN 0
        ELSE ${nonWhitespaceLengthSql}
      END
    ), 0) AS usefulCharacters
    FROM documents d
    LEFT JOIN chunks c ON c.document_id = d.id
    GROUP BY d.id, d.path
  `).all() as unknown as Array<{ path: string; usefulCharacters: number }>;
}

export function saveKnowledgeDocument(document: KnowledgeDocumentInput) {
  const db = getDatabase();
  if (nativeVectorAvailable) invalidateNativeVectorIndex(db);
  db.exec("BEGIN");
  try {
    const prior = db.prepare("SELECT id FROM documents WHERE path = ?").get(document.path) as { id: string } | undefined;
    if (prior) {
      db.prepare("DELETE FROM chunks_fts WHERE document_id = ?").run(prior.id);
      db.prepare("DELETE FROM chunks WHERE document_id = ?").run(prior.id);
      db.prepare("DELETE FROM documents WHERE id = ?").run(prior.id);
    }
    db.prepare(`INSERT INTO documents (id, path, title, format, size_bytes, sha256, chunk_count, ingested_at, ingestion_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(document.id, document.path, document.title, document.format, document.sizeBytes, document.sha256, document.chunks.length, new Date().toISOString(), knowledgeIngestionVersion);
    const insertChunk = db.prepare("INSERT INTO chunks (id, document_id, ordinal, content, embedding, heading, section_path, page_start, page_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insertFts = db.prepare("INSERT INTO chunks_fts (chunk_id, document_id, title, content) VALUES (?, ?, ?, ?)");
    for (const chunk of document.chunks) {
      insertChunk.run(chunk.id, document.id, chunk.ordinal, chunk.content, chunk.embedding ? JSON.stringify(chunk.embedding) : null, chunk.heading ?? null, chunk.sectionPath ?? null, chunk.pageStart ?? null, chunk.pageEnd ?? null);
      insertFts.run(chunk.id, document.id, document.title, [chunk.sectionPath, chunk.heading, chunk.content].filter(Boolean).join("\n"));
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

const knowledgeSubjectPatterns = {
  python: /\bpython|fluent python|effective python|namespaces?|decorators?|asyncio|pip\b/i,
  sql: /\bsql|relational|database|joins?|queries|duckdb|snowflake|group by|having|window functions?|row_number|common table expressions?|\bcte\b|transactions?|\bacid\b|execution plans?\b/i,
  "data-platform": /\bpandas|numpy|spark|pyspark|databricks|dataframe\b/i,
  "machine-learning": /machine.?learning|\bstatistical learning|scikit|clustering|classification|neural|gradient boost|random forest|cross[- ]validation|data leakage|feature engineering|regulari[sz]ation|bias[- ]variance\b/i,
  statistics: /\bstatistics|statistical inference|bayes(?:ian)?|frequentist|confidence interval|hypothesis|probability|p[- ]?values?|bootstrap|correlation|causation|mean|median\b/i,
  visualization: /\bvisuali[sz]|charts?|plots?|matplotlib|seaborn|graphics|dashboards?|data stor(?:y|ies)|truncated axis|chart axis\b/i,
  "indian-mythology": /\bramayana|mahabharata|hindu|indian myth|rama|sita|hanuman|shiva|pandava|kaurava|arjuna|krishna\b/i,
  "greek-mythology": /\bgreek\b|zeus|hera|olymp|hesiod/i,
  "egyptian-mythology": /\begypt(?:ian)?\b|osiris|isis|horus|\bra\b/i,
  history: /\bhistory|historical|archaeolog|ancient civilisation|ancient civilization\b/i,
} as const;

export function inferKnowledgeSubjects(text: string) {
  return Object.entries(knowledgeSubjectPatterns).filter(([, pattern]) => pattern.test(text)).map(([subject]) => subject);
}

export function filterKnowledgeResultsBySubject(query: string, results: KnowledgeResult[]) {
  const querySubjects = new Set(inferKnowledgeSubjects(query));
  if (!querySubjects.size) return results;
  return results.filter((result) => {
    const sourceSubjects = inferKnowledgeSubjects(result.title);
    return !sourceSubjects.length || sourceSubjects.some((subject) => querySubjects.has(subject));
  });
}

export function diversifyKnowledgeResults(results: KnowledgeResult[], limit: number) {
  if (limit <= 0 || !results.length) return [];
  const ranked = [...results].sort((left, right) => right.score - left.score);
  const relevanceFloor = ranked[0].score * .72;
  const relevant = ranked.filter((result) => result.score >= relevanceFloor);
  if (new Set(relevant.map((result) => result.path)).size < 2) return ranked.slice(0, limit);
  const selected: KnowledgeResult[] = [];
  const selectedKeys = new Set<string>();
  const sources = new Set<string>();
  for (const result of relevant) {
    if (sources.has(result.path)) continue;
    selected.push(result);
    selectedKeys.add(`${result.path}:${result.chunk}`);
    sources.add(result.path);
    if (selected.length === limit) return selected;
  }
  const perSourceLimit = Math.max(2, Math.ceil(limit / 2));
  const counts = new Map<string, number>(selected.map((result) => [result.path, 1]));
  for (const result of ranked) {
    const key = `${result.path}:${result.chunk}`;
    if (selectedKeys.has(key) || (counts.get(result.path) ?? 0) >= perSourceLimit) continue;
    selected.push(result);
    selectedKeys.add(key);
    counts.set(result.path, (counts.get(result.path) ?? 0) + 1);
    if (selected.length === limit) return selected;
  }
  return selected;
}

export async function searchKnowledgeWithDiagnostics(query: string, limit = 6): Promise<KnowledgeSearchResponse> {
  const expression = ftsQuery(query);
  if (!expression) return { results: [], mode: "keyword-only" };
  const terms = knowledgeQueryTerms(query);
  const rows = getDatabase().prepare(`
    SELECT d.title, d.path, c.ordinal AS chunk, c.content, c.heading, c.section_path AS sectionPath, c.page_start AS pageStart, c.page_end AS pageEnd, bm25(chunks_fts, 8.0, 1.0) AS rank
    FROM chunks_fts
    JOIN chunks c ON c.id = chunks_fts.chunk_id
    JOIN documents d ON d.id = chunks_fts.document_id
    WHERE chunks_fts MATCH ?
    ORDER BY rank LIMIT ?
  `).all(expression, Math.max(limit * 6, 24)) as unknown as Array<Omit<KnowledgeResult, "score"> & { rank: number }>;
  const lexical = rows.map(({ rank: _rank, ...row }, index) => ({ ...row, lexicalScore: Math.max(.35, 1 - index / Math.max(rows.length, 1)) }));
  const queryEmbedding = process.env.KNOWLEDGE_DISABLE_EMBEDDINGS === "1" ? null : await embedQuery(query);
  if (!queryEmbedding) return {
    results: diversifyKnowledgeResults(filterKnowledgeResultsBySubject(query, lexical.map(({ lexicalScore, ...result }) => ({ ...result, score: lexicalScore }))), limit),
    mode: "keyword-only",
  };
  const semanticLimit = Math.max(limit * 6, 24);
  const nativeSemantic = nativeSemanticSearch(queryEmbedding, semanticLimit);
  const embeddedRows = nativeSemantic ? [] : getDatabase().prepare(`
    SELECT d.title, d.path, c.ordinal AS chunk, c.content, c.heading, c.section_path AS sectionPath, c.page_start AS pageStart, c.page_end AS pageEnd, c.embedding
    FROM chunks c JOIN documents d ON d.id = c.document_id
    WHERE c.embedding IS NOT NULL
  `).all() as unknown as Array<Omit<KnowledgeResult, "score"> & { embedding: string }>;
  const semantic = nativeSemantic ?? embeddedRows.map(({ embedding, ...row }) => ({ ...row, similarity: cosine(queryEmbedding, JSON.parse(embedding) as number[]) }))
    .sort((a, b) => b.similarity - a.similarity).slice(0, semanticLimit);
  const combined = new Map<string, KnowledgeResult & { lexical?: boolean; similarity?: number }>();
  for (const result of lexical) {
    const title = result.title.toLowerCase();
    const titleBoost = terms.some((term) => title.includes(term)) ? .35 : 0;
    const { lexicalScore, ...knowledgeResult } = result;
    combined.set(`${result.path}:${result.chunk}`, { ...knowledgeResult, score: lexicalScore * .68 + titleBoost, lexical: true });
  }
  for (const result of semantic) {
    const key = `${result.path}:${result.chunk}`;
    const prior = combined.get(key);
    if (!prior && result.similarity < .46) continue;
    const { similarity, ...knowledgeResult } = result;
    combined.set(key, { ...(prior ?? knowledgeResult), score: (prior?.score ?? 0) + similarity * .32, lexical: prior?.lexical, similarity });
  }
  const ranked = [...combined.values()]
    .filter((result) => result.lexical || (result.similarity ?? 0) >= .46)
    .sort((a, b) => b.score - a.score)
    .map(({ lexical: _lexical, similarity: _similarity, ...result }) => result);
  return { results: diversifyKnowledgeResults(filterKnowledgeResultsBySubject(query, ranked), limit), mode: "hybrid" };
}

export async function searchKnowledge(query: string, limit = 6): Promise<KnowledgeResult[]> {
  return (await searchKnowledgeWithDiagnostics(query, limit)).results;
}

function nativeSemanticSearch(queryEmbedding: number[], limit: number) {
  try {
    if (!ensureNativeVectorIndex(queryEmbedding.length)) return null;
    const db = getDatabase();
    const nearest = db.prepare(`SELECT rowid, distance FROM chunk_vectors WHERE embedding MATCH ? AND k = ${Math.max(1, Math.floor(limit))} ORDER BY distance`)
      .all(vectorBlob(queryEmbedding)) as unknown as Array<{ rowid: number; distance: number }>;
    const lookup = db.prepare(`SELECT d.title, d.path, c.ordinal AS chunk, c.content, c.heading, c.section_path AS sectionPath, c.page_start AS pageStart, c.page_end AS pageEnd
      FROM chunks c JOIN documents d ON d.id = c.document_id WHERE c.rowid = ?`);
    return nearest.flatMap((match) => {
      const row = lookup.get(BigInt(match.rowid)) as Omit<KnowledgeResult, "score"> | undefined;
      return row ? [{ ...row, similarity: 1 - match.distance }] : [];
    });
  } catch {
    return null;
  }
}

async function embedQuery(input: string): Promise<number[] | null> {
  try {
    const response = await fetch(`${getLocalOllamaBaseUrl()}/api/embed`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: embeddingModel, input }), signal: AbortSignal.timeout(30_000) });
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
    return readdirSync(/* turbopackIgnore: true */ path, { withFileTypes: true }).reduce((total, entry) => {
      const child = resolve(path, entry.name);
      return total + (entry.isDirectory() ? directorySize(child) : statSync(/* turbopackIgnore: true */ child).size);
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
  return readdirSync(/* turbopackIgnore: true */ knowledgeInbox, { withFileTypes: true })
    .filter((entry) => entry.isFile() && supported.has(extname(entry.name).toLowerCase()))
    .map((entry) => resolve(knowledgeInbox, entry.name));
}

export function listKnowledgeFiles() {
  return [...listInboxFiles(), ...[knowledgeWeeklyBrief, knowledgeMonthlyBrief].filter((path) => {
    try { return statSync(/* turbopackIgnore: true */ path).isFile(); } catch { return false; }
  })];
}

export function readSourceManifest() {
  const path = resolve(knowledgeRoot, "SOURCE_MANIFEST.json");
  return JSON.parse(readFileSync(/* turbopackIgnore: true */ path, "utf8")) as unknown;
}

export function closeKnowledgeDatabaseForTests() {
  database?.close();
  database = undefined;
  nativeVectorAvailable = false;
}

export function setKnowledgeDatabasePathForTests(path: string) {
  closeKnowledgeDatabaseForTests();
  activeKnowledgeDatabasePath = path;
}
