import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  AlignmentType,
  Document,
  Footer,
  HeadingLevel,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import type { ChatMessage } from "./providers/types";

export type WordDocumentBrief = {
  title: string;
  documentType: "report" | "proposal" | "meeting-notes" | "technical-brief";
  audience: string;
  purpose: string;
  tone: "professional" | "executive" | "friendly" | "technical";
  sourceNotes: string;
};

export type WordDraft = {
  subtitle: string;
  executiveSummary: string;
  sections: Array<{ heading: string; paragraphs: string[]; bullets: string[] }>;
  assumptions: string[];
};

export type WordDocumentPlan =
  | { action: "ask"; question: string }
  | { action: "create"; brief: WordDocumentBrief; draft: WordDraft };

export type QualityCheck = { id: string; label: string; status: "passed" | "warning"; detail: string };
export type WordArtifact = { id: string; title: string; filename: string; previewPages: number; checks: QualityCheck[] };

const defaultArtifactsRoot = resolve(process.cwd(), "data", "artifacts");
let artifactsRoot = defaultArtifactsRoot;
const safeId = /^[0-9a-f-]{36}$/;

function boundedText(value: unknown, name: string, max: number) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new Error(`${name} is required and must be under ${max} characters.`);
  return value.trim();
}

export function validateWordBrief(value: unknown): WordDocumentBrief {
  if (!value || typeof value !== "object") throw new Error("A document brief is required.");
  const input = value as Partial<WordDocumentBrief>;
  const documentTypes = ["report", "proposal", "meeting-notes", "technical-brief"] as const;
  const tones = ["professional", "executive", "friendly", "technical"] as const;
  if (!documentTypes.includes(input.documentType as typeof documentTypes[number])) throw new Error("Choose a supported document type.");
  if (!tones.includes(input.tone as typeof tones[number])) throw new Error("Choose a supported tone.");
  return {
    title: boundedText(input.title, "Title", 160),
    documentType: input.documentType!,
    audience: boundedText(input.audience, "Audience", 240),
    purpose: boundedText(input.purpose, "Purpose", 600),
    tone: input.tone!,
    sourceNotes: boundedText(input.sourceNotes, "Source notes", 20_000),
  };
}

export function parseWordDraft(raw: string): WordDraft {
  const value = JSON.parse(raw) as Partial<WordDraft>;
  if (!value || typeof value !== "object" || !Array.isArray(value.sections) || value.sections.length < 2 || value.sections.length > 10) throw new Error("The local model returned an invalid document structure.");
  const sections = value.sections.map((section) => {
    if (!section || typeof section.heading !== "string" || !section.heading.trim()) return null;
    const paragraphs = Array.isArray(section.paragraphs) ? section.paragraphs.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, 8) : [];
    const bullets = Array.isArray(section.bullets) ? section.bullets.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, 12) : [];
    if (!paragraphs.length && !bullets.length) return null;
    return { heading: section.heading.trim().slice(0, 140), paragraphs: paragraphs.map((item) => item.trim().slice(0, 1800)), bullets: bullets.map((item) => item.trim().slice(0, 600)) };
  }).filter((section): section is NonNullable<typeof section> => Boolean(section));
  if (sections.length < 2) throw new Error("The local model returned fewer than two substantive document sections.");
  return {
    subtitle: typeof value.subtitle === "string" ? value.subtitle.trim().slice(0, 240) : "",
    executiveSummary: boundedText(value.executiveSummary, "Executive summary", 2400),
    sections,
    assumptions: Array.isArray(value.assumptions) ? value.assumptions.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, 8).map((item) => item.trim().slice(0, 500)) : [],
  };
}

export function buildWordDraftPrompt(brief: WordDocumentBrief) {
  return `Create a polished ${brief.documentType} for ${brief.audience}. Purpose: ${brief.purpose}. Tone: ${brief.tone}. Use only the supplied notes for factual claims; do not invent names, numbers, dates, sources, or project behavior. Return JSON only with this shape: {"subtitle":"string","executiveSummary":"string","sections":[{"heading":"string","paragraphs":["string"],"bullets":["string"]}],"assumptions":["string"]}. Use 3-6 useful sections, concise paragraphs, and bullets only when they improve scanning. Source notes:\n${brief.sourceNotes}`;
}

export function buildFallbackWordDraft(brief: WordDocumentBrief): WordDraft {
  const facts = brief.sourceNotes.split(/(?<=[.!?])\s+|\n+/).map((item) => item.trim()).filter((item) => (
    Boolean(item)
    && !/\b(create|make|generate|export)\b.{0,45}\b(word|docx|document)\b/i.test(item)
    && !/^create the document now[.!]?$/i.test(item)
  )).slice(0, 12);
  return {
    subtitle: `${brief.documentType.replaceAll("-", " ")} for ${brief.audience}`,
    executiveSummary: `${brief.purpose} This document is intended for ${brief.audience}.`,
    sections: [
      { heading: "Purpose and audience", paragraphs: [brief.purpose, `Intended audience: ${brief.audience}.`], bullets: [] },
      { heading: "Source material", paragraphs: [], bullets: facts.length ? facts : [brief.sourceNotes] },
      { heading: "Review before use", paragraphs: ["Confirm the factual claims, assumptions, and final layout against the original conversation before using or sharing this document."], bullets: [] },
    ],
    assumptions: [],
  };
}

export function shouldPlanWordDocument(messages: ChatMessage[]) {
  const latestUser = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
  if (/\b(create|make|generate|export|prepare|write)\b.{0,45}\b(word|docx|document)\b/i.test(latestUser) || /\b(word|docx|document)\b.{0,45}\b(create|make|generate|export)\b/i.test(latestUser)) return true;
  const lastCreated = messages.findLastIndex((message) => Boolean(message.wordArtifact));
  const lastIntent = messages.findLastIndex((message) => message.artifactIntent === "word");
  return lastIntent > lastCreated;
}

export function buildWordConversationPrompt(messages: ChatMessage[]) {
  const conversation = messages.slice(-14).map((message) => `${message.role.toUpperCase()}: ${message.content.slice(0, 2400)}`).join("\n\n").slice(-20_000);
  return `Decide whether enough information exists to create a professional Word document from this conversation. Required: a usable title, audience, purpose, document type, tone, and factual source material. If anything material is missing, ask exactly one concise natural follow-up question. Otherwise create the document plan and draft using only conversation facts. Never invent names, numbers, dates, citations, decisions, or project behavior. Return JSON only. Ask shape: {"action":"ask","question":"string"}. Create shape: {"action":"create","brief":{"title":"string","documentType":"report|proposal|meeting-notes|technical-brief","audience":"string","purpose":"string","tone":"professional|executive|friendly|technical","sourceNotes":"string"},"draft":{"subtitle":"string","executiveSummary":"string","sections":[{"heading":"string","paragraphs":["string"],"bullets":["string"]}],"assumptions":["string"]}}.\n\nCONVERSATION:\n${conversation}`;
}

export function parseWordDocumentPlan(raw: string, fallbackSourceNotes = ""): WordDocumentPlan {
  const value = JSON.parse(raw) as { action?: unknown; question?: unknown; brief?: unknown; draft?: unknown };
  if (value.action === "ask") return { action: "ask", question: boundedText(value.question, "Follow-up question", 500) };
  if (value.action === "create") {
    const brief = value.brief && typeof value.brief === "object" ? { ...(value.brief as Record<string, unknown>) } : {};
    if (typeof brief.sourceNotes !== "string" || !brief.sourceNotes.trim()) brief.sourceNotes = fallbackSourceNotes.slice(-20_000);
    const validatedBrief = validateWordBrief(brief);
    let draft: WordDraft;
    try {
      draft = parseWordDraft(JSON.stringify(value.draft));
    } catch {
      draft = buildFallbackWordDraft(validatedBrief);
    }
    return { action: "create", brief: validatedBrief, draft };
  }
  throw new Error("The local model returned an invalid document action.");
}

function contentParagraph(text: string) {
  return new Paragraph({ children: [new TextRun({ text, size: 22, color: "273444" })], spacing: { after: 180, line: 300 } });
}

export async function createWordArtifact(brief: WordDocumentBrief, draft: WordDraft): Promise<WordArtifact> {
  const id = randomUUID();
  const directory = resolve(artifactsRoot, id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const children: Array<Paragraph | Table> = [
    new Paragraph({ children: [new TextRun({ text: brief.title, bold: true, size: 42, color: "173B2D" })], spacing: { after: 100 } }),
    new Paragraph({ children: [new TextRun({ text: draft.subtitle || `${brief.documentType.replaceAll("-", " ")} for ${brief.audience}`, size: 22, color: "6B756F" })], spacing: { after: 360 } }),
    new Table({ width: { size: 9360, type: WidthType.DXA }, columnWidths: [1900, 7460], rows: [
      new TableRow({ children: [new TableCell({ width: { size: 1900, type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, fill: "E9F1EC" }, children: [new Paragraph({ children: [new TextRun({ text: "PURPOSE", bold: true, size: 18, color: "406B58" })] })] }), new TableCell({ width: { size: 7460, type: WidthType.DXA }, children: [new Paragraph({ children: [new TextRun({ text: brief.purpose, size: 20, color: "273444" })] })] })] }),
      new TableRow({ children: [new TableCell({ width: { size: 1900, type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, fill: "E9F1EC" }, children: [new Paragraph({ children: [new TextRun({ text: "AUDIENCE", bold: true, size: 18, color: "406B58" })] })] }), new TableCell({ width: { size: 7460, type: WidthType.DXA }, children: [new Paragraph({ children: [new TextRun({ text: brief.audience, size: 20, color: "273444" })] })] })] }),
    ] }),
    new Paragraph({ text: "Executive summary", heading: HeadingLevel.HEADING_1, spacing: { before: 360, after: 160 } }),
    contentParagraph(draft.executiveSummary),
  ];
  for (const section of draft.sections) {
    children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1, pageBreakBefore: false, spacing: { before: 300, after: 140 } }));
    children.push(...section.paragraphs.map(contentParagraph));
    children.push(...section.bullets.map((text) => new Paragraph({ text, numbering: { reference: "artifact-bullets", level: 0 }, spacing: { after: 100, line: 280 } })));
  }
  if (draft.assumptions.length) {
    children.push(new Paragraph({ text: "Assumptions to review", heading: HeadingLevel.HEADING_1, spacing: { before: 300, after: 140 } }));
    children.push(...draft.assumptions.map((text) => new Paragraph({ text, numbering: { reference: "artifact-bullets", level: 0 }, spacing: { after: 100 } })));
  }
  const document = new Document({
    styles: { default: { document: { run: { font: "Aptos", size: 22, color: "273444" }, paragraph: { spacing: { line: 300 } } } }, paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: "Aptos Display", size: 28, bold: true, color: "173B2D" }, paragraph: { spacing: { before: 300, after: 140 }, keepNext: true } },
    ] },
    numbering: { config: [{ reference: "artifact-bullets", levels: [{ level: 0, format: "bullet", text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 260 } } } }] }] },
    sections: [{ properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } }, footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: "Rangabot · Local document · ", size: 16, color: "78827D" }), new TextRun({ children: [PageNumber.CURRENT], size: 16, color: "78827D" })] })] }) }, children }],
  });
  const buffer = await Packer.toBuffer(document);
  const filename = `${brief.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70) || "rangabot-document"}.docx`;
  const documentPath = resolve(directory, filename);
  writeFileSync(documentPath, buffer, { mode: 0o600 });
  const checks: QualityCheck[] = [
    { id: "structured-brief", label: "Structured brief", status: "passed", detail: "Title, audience, purpose, type, tone and source notes were provided." },
    { id: "content-completeness", label: "Content completeness", status: draft.sections.length >= 3 ? "passed" : "warning", detail: `${draft.sections.length} sections and ${draft.assumptions.length} assumptions generated.` },
    { id: "source-grounding", label: "Source grounding", status: "warning", detail: "The model was restricted to supplied notes, but factual claims still require human confirmation." },
    { id: "deterministic-render", label: "Deterministic DOCX", status: "passed", detail: "Styles, margins, table widths, numbering and footer were applied by the renderer." },
    { id: "format-validation", label: "DOCX format", status: buffer.subarray(0, 2).toString() === "PK" && buffer.length > 5_000 ? "passed" : "warning", detail: `${Math.round(buffer.length / 1024)} KB Office Open XML package created.` },
  ];
  const previewPages = renderPreview(documentPath, directory, checks);
  checks.push({ id: "user-preview", label: "User review", status: "warning", detail: "Review every rendered page and confirm factual accuracy before final use." });
  const artifact = { id, title: brief.title, filename, previewPages, checks };
  writeFileSync(resolve(directory, "artifact.json"), JSON.stringify({ artifact, brief, draft }, null, 2), { encoding: "utf8", mode: 0o600 });
  return artifact;
}

function renderPreview(documentPath: string, directory: string, checks: QualityCheck[]) {
  const renderHome = resolve(directory, "render-home");
  mkdirSync(renderHome, { recursive: true });
  const office = spawnSync("soffice", ["--headless", "--convert-to", "pdf", "--outdir", directory, documentPath], { env: { ...process.env, HOME: renderHome }, encoding: "utf8", timeout: 60_000 });
  const pdfPath = resolve(directory, `${basename(documentPath, ".docx")}.pdf`);
  if (office.status !== 0 || !existsSync(pdfPath)) {
    checks.push({ id: "visual-review", label: "Visual preview", status: "warning", detail: "LibreOffice rendering is unavailable; inspect the DOCX in Word before final use." });
    return 0;
  }
  const raster = spawnSync("pdftoppm", ["-png", "-r", "110", pdfPath, resolve(directory, "preview")], { encoding: "utf8", timeout: 60_000 });
  if (raster.status !== 0) {
    checks.push({ id: "visual-review", label: "Visual preview", status: "warning", detail: "The PDF rendered, but page images could not be created." });
    return 0;
  }
  let pages = 0;
  while (existsSync(resolve(directory, `preview-${pages + 1}.png`))) pages += 1;
  checks.push({ id: "visual-review", label: "Rendered preview", status: pages ? "passed" : "warning", detail: pages ? `${pages} page${pages === 1 ? "" : "s"} rendered locally for review.` : "No preview pages were produced." });
  return pages;
}

export function resolveArtifactFile(id: string, filename: string) {
  if (!safeId.test(id) || basename(filename) !== filename) return null;
  const path = resolve(artifactsRoot, id, filename);
  return existsSync(path) ? path : null;
}

export function readArtifactMetadata(id: string) {
  const path = safeId.test(id) ? resolve(artifactsRoot, id, "artifact.json") : "";
  if (!path || !existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as { artifact: WordArtifact };
}

export function setArtifactsRootForTests(path: string) {
  artifactsRoot = path;
}

export function resetArtifactsRootForTests() {
  artifactsRoot = defaultArtifactsRoot;
}
