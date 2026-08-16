import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { runtimePaths } from "./runtime-paths.ts";

const maximumExcludedIds = 60;
const maximumDocuments = 12;
const maximumChunksPerWindow = 8;
const maximumGlobalWindows = 8;
const maximumChunkCharacters = 12_000;
const minimumFactCharacters = 40;
const maximumFactCharacters = 180;
const opaqueIdPattern = /^wf_[A-Za-z0-9_-]{20}$/;
const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });

export type BookWelcomeFact = {
  id: string;
  kind: "BOOK_FACT";
  text: string;
  source: {
    title: string;
    heading?: string;
    pageStart?: number;
    pageEnd?: number;
  };
};

export type BookWelcomeResponse =
  | { status: "ready"; fact: BookWelcomeFact }
  | { status: "empty"; fact: null };

type IndexedChunk = {
  documentId: string;
  chunkId: string;
  title: string;
  content: string;
  heading: string | null;
  sectionPath: string | null;
  pageStart: number | null;
  pageEnd: number | null;
};

type IndexedDocument = { id: string; title: string; chunkCount: number };

function boundedRandom(random: () => number) {
  const value = random();
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 0.999999999999) : 0;
}

function plainMetadata(value: string | null, maximum: number) {
  if (!value) return "";
  return value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function opaqueFactId(row: IndexedChunk, sentenceIndex: number, text: string) {
  const digest = createHash("sha256")
    .update([row.documentId, row.chunkId, String(sentenceIndex), text].join("\u0000"))
    .digest("base64url")
    .slice(0, 20);
  return `wf_${digest}`;
}

function looksLikePrivateOrExecutableText(value: string) {
  return /(?:https?:\/\/|www\.|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:api[_ -]?key|access[_ -]?token|secret|password)\b\s*[:=]|-----BEGIN [A-Z ]+PRIVATE KEY-----)/i.test(value)
    || /(?:<\/?[a-z][^>]*>|```|`[^`]+`|\{[^{}]{0,120}\}|\[[^\]]+\]\([^)]*\))/i.test(value)
    || /\b(?:ignore|disregard|override)\b.{0,35}\b(?:instruction|prompt|evidence|previous|system)\b/i.test(value);
}

function isSelfContainedSentence(value: string) {
  if (value.length < minimumFactCharacters || value.length > maximumFactCharacters) return false;
  if (!/[.!?。！？।॥][\"'”’)]?$/.test(value)) return false;
  if (/^(?:[#>*`|]|[-+•]\s|\d+[.)]\s|\[page\s+\d+\])/i.test(value)) return false;
  if (/^(?:this|that|these|those|it|they|he|she|we|i|you)\b/i.test(value)) return false;
  if (/\b(?:figure|table|diagram|chapter|section|page)\s+(?:above|below|following|previous|next|\d+)\b/i.test(value)) return false;
  if (looksLikePrivateOrExecutableText(value)) return false;
  const tokens = value.match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.length >= 7;
}

export function extractBookWelcomeFacts(row: IndexedChunk): BookWelcomeFact[] {
  const title = plainMetadata(row.title, 160);
  if (!title || !row.content || row.content.length > maximumChunkCharacters) return [];
  const heading = plainMetadata(row.heading || row.sectionPath, 160);
  const candidates: BookWelcomeFact[] = [];
  let sentenceIndex = 0;
  for (const segment of sentenceSegmenter.segment(row.content)) {
    const text = segment.segment.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    const currentIndex = sentenceIndex;
    sentenceIndex += 1;
    if (!isSelfContainedSentence(text)) continue;
    const pageStart = Number.isInteger(row.pageStart) && (row.pageStart ?? 0) > 0 ? row.pageStart ?? undefined : undefined;
    const pageEnd = Number.isInteger(row.pageEnd) && (row.pageEnd ?? 0) >= (pageStart ?? 1) ? row.pageEnd ?? undefined : undefined;
    candidates.push({
      id: opaqueFactId(row, currentIndex, text),
      kind: "BOOK_FACT",
      text,
      source: {
        title,
        ...(heading ? { heading } : {}),
        ...(pageStart ? { pageStart } : {}),
        ...(pageEnd ? { pageEnd } : {}),
      },
    });
    if (candidates.length === 4) break;
  }
  return candidates;
}

export function parseExcludedBookWelcomeIds(url: URL) {
  const values = url.searchParams.getAll("exclude")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => opaqueIdPattern.test(value));
  return [...new Set(values)].slice(0, maximumExcludedIds);
}

function rotated<T>(values: T[], random: () => number) {
  if (values.length < 2) return values;
  const start = Math.floor(boundedRandom(random) * values.length);
  return [...values.slice(start), ...values.slice(0, start)];
}

function ordinalWindows(count: number, random: () => number) {
  if (count <= maximumChunksPerWindow) return [1];
  return [...new Set([
    Math.floor(boundedRandom(random) * count) + 1,
    1,
    Math.floor(count / 2) + 1,
    Math.max(1, count - maximumChunksPerWindow + 1),
  ].map((ordinal) => Math.min(ordinal, Math.max(1, count))))];
}

function hasDocumentOrdinalIndex(database: InstanceType<typeof DatabaseSync>) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'chunks_document_ordinal_idx'").get());
}

function chooseFromChunks(chunks: IndexedChunk[], excluded: Set<string>, seenText: Set<string>) {
  for (const chunk of chunks) {
    const fact = extractBookWelcomeFacts(chunk).find((candidate) => {
      const normalized = candidate.text.normalize("NFKC").toLowerCase();
      return !excluded.has(candidate.id) && !seenText.has(normalized);
    });
    if (fact) return fact;
  }
  return undefined;
}

function selectWithDocumentIndex(
  database: InstanceType<typeof DatabaseSync>,
  excluded: Set<string>,
  random: () => number,
) {
  const documents = database.prepare("SELECT id, title, chunk_count AS chunkCount FROM documents WHERE chunk_count > 0 ORDER BY title, id").all() as unknown as IndexedDocument[];
  const candidates: BookWelcomeFact[] = [];
  const seenText = new Set<string>();
  const readWindow = database.prepare(`
    SELECT d.id AS documentId, c.id AS chunkId, d.title, c.content,
      c.heading, c.section_path AS sectionPath, c.page_start AS pageStart, c.page_end AS pageEnd
    FROM chunks c JOIN documents d ON d.id = c.document_id
    WHERE c.document_id = ? AND c.ordinal >= ?
    ORDER BY c.ordinal, c.id LIMIT ?
  `);
  for (const document of rotated(documents, random).slice(0, maximumDocuments)) {
    let selected: BookWelcomeFact | undefined;
    for (const ordinal of ordinalWindows(document.chunkCount, random)) {
      const chunks = readWindow.all(document.id, ordinal, maximumChunksPerWindow) as unknown as IndexedChunk[];
      selected = chooseFromChunks(chunks, excluded, seenText);
      if (selected) break;
    }
    if (!selected) continue;
    candidates.push(selected);
    seenText.add(selected.text.normalize("NFKC").toLowerCase());
  }
  return candidates.length ? candidates[Math.floor(boundedRandom(random) * candidates.length)] ?? null : null;
}

function selectWithRowIdWindows(
  database: InstanceType<typeof DatabaseSync>,
  excluded: Set<string>,
  random: () => number,
) {
  const bounds = database.prepare("SELECT MIN(rowid) AS minimum, MAX(rowid) AS maximum FROM chunks").get() as { minimum: number | null; maximum: number | null };
  if (bounds.minimum === null || bounds.maximum === null) return null;
  const span = Math.max(1, bounds.maximum - bounds.minimum + 1);
  const starts = [...new Set([
    ...Array.from({ length: maximumGlobalWindows - 2 }, () => bounds.minimum! + Math.floor(boundedRandom(random) * span)),
    bounds.minimum,
    Math.max(bounds.minimum, bounds.maximum - maximumChunksPerWindow + 1),
  ])];
  const readWindow = database.prepare(`
    SELECT d.id AS documentId, c.id AS chunkId, d.title, c.content,
      c.heading, c.section_path AS sectionPath, c.page_start AS pageStart, c.page_end AS pageEnd
    FROM chunks c JOIN documents d ON d.id = c.document_id
    WHERE c.rowid >= ? ORDER BY c.rowid LIMIT ?
  `);
  const seenText = new Set<string>();
  for (const rowId of starts) {
    const chunks = readWindow.all(rowId, maximumChunksPerWindow) as unknown as IndexedChunk[];
    const fact = chooseFromChunks(chunks, excluded, seenText);
    if (fact) return fact;
  }
  return null;
}

export function selectBookWelcomeFact(options: {
  databasePath?: string;
  excludedIds?: Iterable<string>;
  random?: () => number;
} = {}): BookWelcomeFact | null {
  const databasePath = options.databasePath ?? runtimePaths.knowledgeDatabase;
  if (!existsSync(/*turbopackIgnore: true*/ databasePath)) return null;
  const random = options.random ?? Math.random;
  const excluded = new Set([...options.excludedIds ?? []].filter((id) => opaqueIdPattern.test(id)).slice(0, maximumExcludedIds));
  let database: InstanceType<typeof DatabaseSync> | undefined;
  try {
    database = new DatabaseSync(/*turbopackIgnore: true*/ databasePath, { readOnly: true });
    return hasDocumentOrdinalIndex(database)
      ? selectWithDocumentIndex(database, excluded, random)
      : selectWithRowIdWindows(database, excluded, random);
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

export function buildBookWelcomeResponse(
  request: Request,
  options: { databasePath?: string; random?: () => number } = {},
) {
  const excludedIds = parseExcludedBookWelcomeIds(new URL(request.url));
  const fact = selectBookWelcomeFact({ ...options, excludedIds });
  const body: BookWelcomeResponse = fact ? { status: "ready", fact } : { status: "empty", fact: null };
  return Response.json(body, {
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
