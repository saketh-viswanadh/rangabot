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
  documentType: "report" | "proposal" | "meeting-notes" | "technical-brief" | "guide" | "article" | "story-collection";
  audience: string;
  purpose: string;
  tone: "professional" | "executive" | "friendly" | "technical" | "warm" | "playful";
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
export type StoryDraftPart = { title: string; paragraphs: string[]; reflection: string };

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
  const documentTypes = ["report", "proposal", "meeting-notes", "technical-brief", "guide", "article", "story-collection"] as const;
  const tones = ["professional", "executive", "friendly", "technical", "warm", "playful"] as const;
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
  const storyInstructions = brief.documentType === "story-collection"
    ? `Write the actual story collection, not a report, outline, lesson plan, or description of what could be written. Create 4-6 complete, vivid, age-appropriate stories. Each story needs a compelling title, a clear beginning, challenge, and satisfying resolution, with sensory detail and natural dialogue where useful. Keep violence non-graphic. Put one complete story in each section's paragraphs. End each story with one short "Think about it" bullet that invites reflection without sounding preachy. The combined story prose must be at least 360 words. The executiveSummary is a short inviting introduction for the child reader, never a business summary. Do not include planning notes, prompts, source material, review instructions, or a purpose/audience section.`
    : `Write the complete requested content, not an outline or a description of the planned document. Use 3-6 substantive sections and concise paragraphs; use bullets only when they improve scanning. Do not expose planning notes or chat transcripts in the document.`;
  return `Create a polished ${brief.documentType} for ${brief.audience}. Purpose: ${brief.purpose}. Tone: ${brief.tone}. ${storyInstructions} Use the supplied notes to understand the request. You may use stable general knowledge needed to fulfill educational or creative writing, but do not fabricate citations, quotations, dates, or disputed details. Return JSON only with this shape: {"subtitle":"string","executiveSummary":"string","sections":[{"heading":"string","paragraphs":["string"],"bullets":["string"]}],"assumptions":["string"]}. Request notes (never reproduce these verbatim as document content):\n${brief.sourceNotes}`;
}

function draftWordCount(draft: WordDraft) {
  return [draft.executiveSummary, ...draft.sections.flatMap((section) => [...section.paragraphs, ...section.bullets])]
    .join(" ").trim().split(/\s+/).filter(Boolean).length;
}

export function validateWordDraftForBrief(brief: WordDocumentBrief, draft: WordDraft) {
  const forbiddenScaffolding = /^(purpose and audience|source material|review before use|missing information)$/i;
  if (draft.sections.some((section) => forbiddenScaffolding.test(section.heading.trim()))) {
    throw new Error("The draft contains internal planning scaffolding instead of finished content.");
  }
  if (brief.documentType === "story-collection") {
    if (draft.sections.length < 4) throw new Error("A story collection needs at least four complete stories.");
    if (draftWordCount(draft) < 360) throw new Error("The story collection is too short to be useful.");
    if (draft.sections.some((section) => section.paragraphs.join(" ").split(/\s+/).filter(Boolean).length < 80)) {
      throw new Error("Every story must contain a complete narrative, not a synopsis.");
    }
  }
  return draft;
}

export function parseStoryDraftPart(raw: string): StoryDraftPart {
  const value = JSON.parse(raw) as Partial<StoryDraftPart>;
  const title = boundedText(value.title, "Story title", 140);
  const paragraphs = Array.isArray(value.paragraphs)
    ? value.paragraphs.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim().slice(0, 2400)).slice(0, 8)
    : [];
  const reflection = typeof value.reflection === "string" && value.reflection.trim()
    ? value.reflection.trim().slice(0, 300)
    : `Which choice in “${title}” showed the strongest loyalty, and why?`;
  if (paragraphs.join(" ").split(/\s+/).filter(Boolean).length < 80) throw new Error("The generated story is only a synopsis.");
  return { title, paragraphs, reflection };
}

export function buildStoryPartPrompt(brief: WordDocumentBrief, story: string, sourceContext: string) {
  return `Write one complete, vivid story for ${brief.audience} as part of "${brief.title}". Episode: ${story}. Theme: ${brief.purpose}. Use warm, clear language, a strong opening, natural dialogue where helpful, a challenge, and a satisfying resolution. Write 170-240 words. Keep violence non-graphic. Preserve the relationships and outcome in the local source excerpts. Do not invent a character's death, move an event to a different kingdom, or claim a character performed another character's deed. Do not mention sources, prompts, reports, or document creation. Return JSON only: {"title":"engaging story title","paragraphs":["3-5 complete story paragraphs"],"reflection":"one short open-ended Think about it question"}.\n\nLOCAL SOURCE EXCERPTS:\n${sourceContext.slice(0, 2800)}`;
}

export function assembleStoryCollectionDraft(brief: WordDocumentBrief, stories: StoryDraftPart[]): WordDraft {
  if (stories.length < 4) throw new Error("At least four stories are required.");
  const audience = brief.audience.charAt(0).toLowerCase() + brief.audience.slice(1);
  return validateWordDraftForBrief(brief, {
    subtitle: `Stories of courage, friendship, and ${/loyal/i.test(brief.purpose) ? "loyalty" : "wisdom"}`,
    executiveSummary: `Step into the world of ${/ramayana/i.test(`${brief.title} ${brief.purpose} ${brief.sourceNotes}`) ? "the Ramayana" : "these timeless tales"}. Each story is retold in clear, lively language for ${audience}, with a question at the end to help you think about the choices the characters make.`,
    sections: stories.map((story) => ({ heading: story.title, paragraphs: story.paragraphs, bullets: [`Think about it: ${story.reflection.replace(/^think about it:\s*/i, "")}`] })),
    assumptions: [],
  });
}

export function buildFallbackWordDraft(brief: WordDocumentBrief): WordDraft {
  if (brief.documentType === "story-collection") {
    throw new Error("Rangabot will not replace missing stories with a generic document template.");
  }
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
  return `Decide whether enough information exists to create the Word document requested in this conversation. First identify the correct genre. Use story-collection for collections of stories, including mythology for children; never force creative or educational writing into a business report. Required: a usable title, audience, purpose, document type, tone, and topic. If anything material is missing, ask exactly one concise natural follow-up question. Otherwise return a brief and a best-effort complete draft. Write finished reader-facing content, never a transcript, source-material dump, outline, or commentary about what the document should contain. Never reproduce requirement-gathering answers verbatim as sections. Return JSON only. Ask shape: {"action":"ask","question":"string"}. Create shape: {"action":"create","brief":{"title":"string","documentType":"report|proposal|meeting-notes|technical-brief|guide|article|story-collection","audience":"string","purpose":"string","tone":"professional|executive|friendly|technical|warm|playful","sourceNotes":"string"},"draft":{"subtitle":"string","executiveSummary":"string","sections":[{"heading":"string","paragraphs":["string"],"bullets":["string"]}],"assumptions":["string"]}}.\n\nCONVERSATION:\n${conversation}`;
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
      draft = validateWordDraftForBrief(validatedBrief, parseWordDraft(JSON.stringify(value.draft)));
    } catch {
      draft = buildFallbackWordDraft(validatedBrief);
    }
    return { action: "create", brief: validatedBrief, draft };
  }
  throw new Error("The local model returned an invalid document action.");
}

export function parseWordBriefFromPlan(raw: string, fallbackSourceNotes = "") {
  const value = JSON.parse(raw) as { action?: unknown; brief?: unknown };
  if (value.action !== "create" || !value.brief || typeof value.brief !== "object") return null;
  const brief = { ...(value.brief as Record<string, unknown>) };
  if (typeof brief.sourceNotes !== "string" || !brief.sourceNotes.trim()) brief.sourceNotes = fallbackSourceNotes.slice(-20_000);
  return validateWordBrief(brief);
}

function contentParagraph(text: string) {
  return new Paragraph({ children: [new TextRun({ text, size: 22, color: "273444" })], spacing: { after: 180, line: 300 } });
}

export async function createWordArtifact(brief: WordDocumentBrief, draft: WordDraft): Promise<WordArtifact> {
  validateWordDraftForBrief(brief, draft);
  const id = randomUUID();
  const directory = resolve(artifactsRoot, id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const children: Array<Paragraph | Table> = [
    new Paragraph({ children: [new TextRun({ text: brief.title, bold: true, size: 42, color: "173B2D" })], spacing: { after: 100 } }),
    new Paragraph({ children: [new TextRun({ text: draft.subtitle || `${brief.documentType.replaceAll("-", " ")} for ${brief.audience}`, size: 22, color: "6B756F" })], spacing: { after: 360 } }),
  ];
  if (brief.documentType !== "story-collection") children.push(
    new Table({ width: { size: 9360, type: WidthType.DXA }, columnWidths: [1900, 7460], rows: [
      new TableRow({ children: [new TableCell({ width: { size: 1900, type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, fill: "E9F1EC" }, children: [new Paragraph({ children: [new TextRun({ text: "PURPOSE", bold: true, size: 18, color: "406B58" })] })] }), new TableCell({ width: { size: 7460, type: WidthType.DXA }, children: [new Paragraph({ children: [new TextRun({ text: brief.purpose, size: 20, color: "273444" })] })] })] }),
      new TableRow({ children: [new TableCell({ width: { size: 1900, type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, fill: "E9F1EC" }, children: [new Paragraph({ children: [new TextRun({ text: "AUDIENCE", bold: true, size: 18, color: "406B58" })] })] }), new TableCell({ width: { size: 7460, type: WidthType.DXA }, children: [new Paragraph({ children: [new TextRun({ text: brief.audience, size: 20, color: "273444" })] })] })] }),
    ] }),
  );
  children.push(
    new Paragraph({ text: brief.documentType === "story-collection" ? "Before you begin" : "Executive summary", heading: HeadingLevel.HEADING_1, spacing: { before: 360, after: 160 } }),
    contentParagraph(draft.executiveSummary),
  );
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
