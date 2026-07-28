import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { load } from "cheerio";
import mammoth from "mammoth";
import { existingDocumentHash, getKnowledgeStatus, hashBuffer, listInboxFiles, saveKnowledgeDocument } from "../lib/knowledge.ts";

function normalizeText(text: string) {
  return text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

async function extractText(path: string, buffer: Buffer) {
  const extension = extname(path).toLowerCase();
  if (extension === ".pdf") {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const pdf = await getDocument({ data: new Uint8Array(buffer) }).promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const content = await (await pdf.getPage(pageNumber)).getTextContent();
      pages.push(`[Page ${pageNumber}]\n${content.items.map((item) => ("str" in item ? item.str : "")).join(" ")}`);
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
  const paragraphs = text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
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

async function embedChunks(chunks: string[]) {
  try {
    const embedded: number[][] = [];
    for (let index = 0; index < chunks.length; index += 32) {
      const response = await fetch("http://127.0.0.1:11434/api/embed", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text", input: chunks.slice(index, index + 32) }) });
      if (!response.ok) return null;
      embedded.push(...(((await response.json()) as { embeddings?: number[][] }).embeddings ?? []));
    }
    return embedded.length === chunks.length ? embedded : null;
  } catch {
    return null;
  }
}

for (const path of listInboxFiles()) {
  const buffer = await readFile(path);
  const status = getKnowledgeStatus();
  if (status.usedBytes + buffer.length > status.budgetBytes) throw new Error(`Knowledge budget exceeded before importing ${basename(path)}`);
  const sha256 = hashBuffer(buffer);
  if (existingDocumentHash(path) === sha256) {
    console.log(`unchanged  ${basename(path)}`);
    continue;
  }
  const text = await extractText(path, buffer);
  const rawChunks = chunkText(text);
  const embeddings = await embedChunks(rawChunks);
  const id = randomUUID();
  saveKnowledgeDocument({
    id,
    path,
    title: basename(path, extname(path)).replaceAll(/[_-]+/g, " "),
    format: extname(path).slice(1).toLowerCase(),
    sizeBytes: buffer.length,
    sha256,
    chunks: rawChunks.map((content, ordinal) => ({ id: randomUUID(), ordinal: ordinal + 1, content, ...(embeddings?.[ordinal] ? { embedding: embeddings[ordinal] } : {}) })),
  });
  console.log(`indexed    ${basename(path)} (${rawChunks.length} chunks${embeddings ? ", embedded" : ", keyword-only"})`);
}

const finalStatus = getKnowledgeStatus();
console.log(`vault      ${finalStatus.documents} documents, ${finalStatus.chunks} chunks, ${(finalStatus.usedBytes / 1024 ** 2).toFixed(1)} MB / ${(finalStatus.budgetBytes / 1024 ** 3).toFixed(1)} GB`);
