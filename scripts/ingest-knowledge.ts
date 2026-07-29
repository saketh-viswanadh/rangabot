import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { load } from "cheerio";
import mammoth from "mammoth";
import { clearKnowledgeSourceIssue, existingDocumentHash, getKnowledgeStatus, hashBuffer, indexedDocumentUsefulCharacters, listKnowledgeFiles, recordKnowledgeSourceIssue, relinkKnowledgeDocumentByHash, removeKnowledgeDocumentByPath, removeKnowledgeDocumentsNotIn, removeKnowledgeSourceIssuesNotIn, saveKnowledgeDocument } from "../lib/knowledge.ts";

function normalizeText(text: string) {
  return text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

async function extractText(path: string, buffer: Buffer, filename: string) {
  const extension = extname(path).toLowerCase();
  if (extension === ".pdf") {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const pdf = await getDocument({ data: new Uint8Array(buffer) }).promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const content = await (await pdf.getPage(pageNumber)).getTextContent();
      pages.push(`[Page ${pageNumber}]\n${content.items.map((item) => ("str" in item ? item.str : "")).join(" ")}`);
      if (pageNumber === 1 || pageNumber === pdf.numPages || pageNumber % 25 === 0) console.log(`extracting ${filename} page ${pageNumber}/${pdf.numPages}`);
    }
    return normalizeText(pages.join("\n\n"));
  }
  if (extension === ".docx") return normalizeText((await mammoth.extractRawText({ buffer })).value);
  if (extension === ".html" || extension === ".htm") {
    const $ = load(buffer.toString("utf8"));
    $("script, style, nav, footer").remove();
    return normalizeText($("body").text());
  }
  return normalizeText(buffer.toString("utf8"));
}

function chunkText(text: string, target = 1_200, overlap = 180) {
  const paragraphs = text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean).flatMap((part) => {
    if (part.length <= target * 1.5) return [part];
    const pieces = [];
    for (let start = 0; start < part.length; start += target - overlap) pieces.push(part.slice(start, start + target));
    return pieces;
  });
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > target) {
      chunks.push(current);
      current = `${current.slice(-overlap)}\n\n${paragraph}`;
    } else current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current) chunks.push(current);
  return chunks.filter((chunk) => chunk.length >= 80);
}

function usefulCharacterCount(text: string) {
  return text.replace(/\[Page\s+\d+\]/gi, "").match(/[\p{L}\p{N}]/gu)?.length ?? 0;
}

async function embedChunks(chunks: string[], filename: string) {
  try {
    const embedded: number[][] = [];
    const batchSize = 32;
    const totalBatches = Math.ceil(chunks.length / batchSize);
    for (let index = 0; index < chunks.length; index += 32) {
      const batch = Math.floor(index / batchSize) + 1;
      console.log(`embedding  ${filename} batch ${batch}/${totalBatches}`);
      const response = await fetch("http://127.0.0.1:11434/api/embed", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text", input: chunks.slice(index, index + batchSize) }), signal: AbortSignal.timeout(120_000) });
      if (!response.ok) {
        console.warn(`fallback   ${filename} embedding request failed (${response.status}); saving a keyword-searchable index`);
        return null;
      }
      embedded.push(...(((await response.json()) as { embeddings?: number[][] }).embeddings ?? []));
    }
    return embedded.length === chunks.length ? embedded : null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown embedding error";
    console.warn(`fallback   ${filename} embeddings unavailable (${reason}); saving a keyword-searchable index`);
    return null;
  }
}

const knowledgeFiles = listKnowledgeFiles();
const failures: string[] = [];
for (const [fileIndex, path] of knowledgeFiles.entries()) {
  const filename = basename(path);
  console.log(`source     ${fileIndex + 1}/${knowledgeFiles.length} ${filename}`);
  const buffer = await readFile(path);
  const status = getKnowledgeStatus();
  if (status.usedBytes + buffer.length > status.budgetBytes) throw new Error(`Knowledge budget exceeded before importing ${basename(path)}`);
  const sha256 = hashBuffer(buffer);
  const title = basename(path, extname(path)).replaceAll(/[_-]+/g, " ");
  const format = extname(path).slice(1).toLowerCase();
  if (existingDocumentHash(path) === sha256 && indexedDocumentUsefulCharacters(path) >= 200) {
    clearKnowledgeSourceIssue(path);
      console.log(`unchanged  ${filename}`);
    continue;
  }
  if (relinkKnowledgeDocumentByHash({ path, title, format, sizeBytes: buffer.length, sha256 })) {
    if (indexedDocumentUsefulCharacters(path) >= 200) {
      clearKnowledgeSourceIssue(path);
      console.log(`relocated  ${filename}`);
      continue;
    }
    console.log(`repairing  ${filename} after detecting an unusable prior extraction`);
  }
  console.log(`extracting ${filename} (${(buffer.length / 1024 ** 2).toFixed(1)} MB)`);
  const text = await extractText(path, buffer, filename);
  const minimumUsefulCharacters = format === "pdf" ? 500 : 80;
  if (usefulCharacterCount(text) < minimumUsefulCharacters) {
    removeKnowledgeDocumentByPath(path);
    const message = `${basename(path)} contains too little extractable text${format === "pdf" ? "; it appears scanned and needs local OCR first" : ""}`;
    failures.push(message);
    recordKnowledgeSourceIssue(path, sha256, message);
    console.error(`skipped    ${message}`);
    continue;
  }
  const rawChunks = chunkText(text);
  console.log(`chunked    ${filename} into ${rawChunks.length} passages`);
  const embeddings = await embedChunks(rawChunks, filename);
  const id = randomUUID();
  saveKnowledgeDocument({
    id,
    path,
    title,
    format,
    sizeBytes: buffer.length,
    sha256,
    chunks: rawChunks.map((content, ordinal) => ({ id: randomUUID(), ordinal: ordinal + 1, content, ...(embeddings?.[ordinal] ? { embedding: embeddings[ordinal] } : {}) })),
  });
  clearKnowledgeSourceIssue(path);
  console.log(`indexed    ${basename(path)} (${rawChunks.length} chunks${embeddings ? ", embedded" : ", keyword-only"})`);
}

const removed = removeKnowledgeDocumentsNotIn(knowledgeFiles);
removeKnowledgeSourceIssuesNotIn(knowledgeFiles);
for (const path of removed) console.log(`removed    stale index entry ${path}`);

const finalStatus = getKnowledgeStatus();
console.log(`vault      ${finalStatus.documents} documents, ${finalStatus.chunks} chunks, ${(finalStatus.usedBytes / 1024 ** 2).toFixed(1)} MB / ${(finalStatus.budgetBytes / 1024 ** 3).toFixed(1)} GB`);
if (failures.length) {
  console.warn(`attention  ${failures.length} incompatible source${failures.length === 1 ? "" : "s"} skipped; compatible sources remain searchable`);
}
