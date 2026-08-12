import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { load } from "cheerio";
import mammoth from "mammoth";
import { clearKnowledgeSourceIssue, closeKnowledgeDatabase, existingDocumentHash, existingDocumentIngestionVersion, getKnowledgeStatus, hashBuffer, indexedDocumentUsefulCharacters, knowledgeDatabasePath, knowledgeInbox, knowledgeIngestionVersion, knowledgeRoot, listKnowledgeFiles, recordKnowledgeSourceIssue, relinkKnowledgeDocumentByHash, removeKnowledgeDocumentByPath, removeKnowledgeDocumentsNotIn, removeKnowledgeSourceIssuesNotIn, saveKnowledgeDocument } from "../lib/knowledge.ts";
import { chunkHierarchicalText } from "../lib/knowledge-ingestion.ts";
import { getConfiguredEmbeddingModel, getLocalOllamaBaseUrl } from "../lib/local-runtime-config.ts";
import { acquireProfileMaintenanceBinding } from "../lib/profile-maintenance.ts";

function normalizeText(text: string) {
  return text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function structuredHtml(html: string) {
  const $ = load(html);
  $("script, style, nav, footer").remove();
  const parts: string[] = [];
  $("body").find("h1, h2, h3, h4, h5, h6, p, li, pre").each((_index, element) => {
    const text = $(element).text().replace(/\s+/g, " ").trim();
    if (!text) return;
    const tag = element.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) parts.push(`${"#".repeat(Number(tag[1]))} ${text}`);
    else parts.push(text);
  });
  return normalizeText(parts.join("\n\n"));
}

async function extractText(path: string, buffer: Buffer, filename: string) {
  const extension = extname(path).toLowerCase();
  if (extension === ".pdf") {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const pdf = await getDocument({ data: new Uint8Array(buffer) }).promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const content = await (await pdf.getPage(pageNumber)).getTextContent();
      const lines: string[] = [];
      let line = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        line += `${line ? " " : ""}${item.str}`;
        if ("hasEOL" in item && item.hasEOL) { if (line.trim()) lines.push(line.trim()); line = ""; }
      }
      if (line.trim()) lines.push(line.trim());
      pages.push(`[Page ${pageNumber}]\n${lines.join("\n")}`);
      if (pageNumber === 1 || pageNumber === pdf.numPages || pageNumber % 25 === 0) console.log(`extracting ${filename} page ${pageNumber}/${pdf.numPages}`);
    }
    return normalizeText(pages.join("\n\n"));
  }
  if (extension === ".docx") return structuredHtml((await mammoth.convertToHtml({ buffer })).value);
  if (extension === ".html" || extension === ".htm") {
    return structuredHtml(buffer.toString("utf8"));
  }
  return normalizeText(buffer.toString("utf8"));
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
      const response = await fetch(`${getLocalOllamaBaseUrl()}/api/embed`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: getConfiguredEmbeddingModel(), input: chunks.slice(index, index + batchSize) }), signal: AbortSignal.timeout(120_000) });
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

const profileMaintenance = acquireProfileMaintenanceBinding({ label: "Knowledge ingestion" });
profileMaintenance.assertDataPath(knowledgeRoot);
profileMaintenance.assertDataPath(knowledgeInbox);
profileMaintenance.assertDataPath(knowledgeDatabasePath);
const knowledgeFiles = listKnowledgeFiles();
const failures: string[] = [];
for (const [fileIndex, path] of knowledgeFiles.entries()) {
  profileMaintenance.assertCurrent();
  const filename = basename(path);
  console.log(`source     ${fileIndex + 1}/${knowledgeFiles.length} ${filename}`);
  const buffer = await readFile(path);
  profileMaintenance.assertCurrent();
  const status = getKnowledgeStatus();
  if (status.usedBytes + buffer.length > status.budgetBytes) throw new Error(`Knowledge budget exceeded before importing ${basename(path)}`);
  const sha256 = hashBuffer(buffer);
  const title = basename(path, extname(path)).replaceAll(/[_-]+/g, " ");
  const format = extname(path).slice(1).toLowerCase();
  if (existingDocumentHash(path) === sha256 && indexedDocumentUsefulCharacters(path) >= 200 && existingDocumentIngestionVersion(path) === knowledgeIngestionVersion) {
    profileMaintenance.assertCurrent();
    clearKnowledgeSourceIssue(path);
      console.log(`unchanged  ${filename}`);
    continue;
  }
  profileMaintenance.assertCurrent();
  if (relinkKnowledgeDocumentByHash({ path, title, format, sizeBytes: buffer.length, sha256 })) {
    if (indexedDocumentUsefulCharacters(path) >= 200 && existingDocumentIngestionVersion(path) === knowledgeIngestionVersion) {
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
    profileMaintenance.assertCurrent();
    removeKnowledgeDocumentByPath(path);
    const message = `${basename(path)} contains too little extractable text${format === "pdf" ? "; it appears scanned and needs local OCR first" : ""}`;
    failures.push(message);
    recordKnowledgeSourceIssue(path, sha256, message);
    console.error(`skipped    ${message}`);
    continue;
  }
  const rawChunks = chunkHierarchicalText(text);
  console.log(`chunked    ${filename} into ${rawChunks.length} passages`);
  const embeddings = await embedChunks(rawChunks.map((chunk) => chunk.content), filename);
  const id = randomUUID();
  profileMaintenance.assertCurrent();
  saveKnowledgeDocument({
    id,
    path,
    title,
    format,
    sizeBytes: buffer.length,
    sha256,
    chunks: rawChunks.map((chunk, ordinal) => ({ id: randomUUID(), ordinal: ordinal + 1, ...chunk, ...(embeddings?.[ordinal] ? { embedding: embeddings[ordinal] } : {}) })),
  });
  clearKnowledgeSourceIssue(path);
  console.log(`indexed    ${basename(path)} (${rawChunks.length} chunks${embeddings ? ", embedded" : ", keyword-only"})`);
}

profileMaintenance.assertCurrent();
const removed = removeKnowledgeDocumentsNotIn(knowledgeFiles);
profileMaintenance.assertCurrent();
removeKnowledgeSourceIssuesNotIn(knowledgeFiles);
for (const path of removed) console.log(`removed    stale index entry ${path}`);

profileMaintenance.assertCurrent();
const finalStatus = getKnowledgeStatus();
console.log(`vault      ${finalStatus.documents} documents, ${finalStatus.chunks} chunks, ${(finalStatus.usedBytes / 1024 ** 2).toFixed(1)} MB / ${(finalStatus.budgetBytes / 1024 ** 3).toFixed(1)} GB`);
if (failures.length) {
  console.warn(`attention  ${failures.length} incompatible source${failures.length === 1 ? "" : "s"} skipped; compatible sources remain searchable`);
}
closeKnowledgeDatabase();
profileMaintenance.release();
