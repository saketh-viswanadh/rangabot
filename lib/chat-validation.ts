import type { ChatMessage } from "./providers/types";
import { expertPackWarningCodes, type ExpertPackWarningCode } from "./expert-packs.ts";

export const MAX_CHAT_MESSAGES = 200;
export const MAX_CHAT_MESSAGE_CHARS = 50_000;
export const MAX_CHAT_TOTAL_CHARS = 1_000_000;
const messageKeys = new Set(["role", "content", "artifactIntent", "wordArtifact", "analysisTrace", "codeContext", "replyTo", "retrievalMode", "memoryUse", "memoryTitles", "answerDisposition"]);
const analysisTraceKeys = new Set(["engine", "dataset", "query", "returnedRows", "truncated", "durationMs", "inputSha256", "querySha256", "packId", "packVersion", "modelMode", "modelId"]);

export function isValidAnalysisTrace(value: unknown): value is NonNullable<ChatMessage["analysisTrace"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const trace = value as Record<string, unknown>;
  const hasPackProvenance = trace.packId !== undefined || trace.packVersion !== undefined;
  const hasModelProvenance = trace.modelMode !== undefined || trace.modelId !== undefined;
  return Object.keys(trace).every((key) => analysisTraceKeys.has(key))
    && trace.engine === "duckdb"
    && typeof trace.dataset === "string" && trace.dataset.length > 0 && trace.dataset.length <= 240
    && typeof trace.query === "string" && trace.query.length > 0 && trace.query.length <= 8_000
    && typeof trace.returnedRows === "number" && Number.isInteger(trace.returnedRows) && trace.returnedRows >= 0 && trace.returnedRows <= 200
    && typeof trace.truncated === "boolean"
    && typeof trace.durationMs === "number" && Number.isInteger(trace.durationMs) && trace.durationMs >= 0 && trace.durationMs <= 30_000
    && typeof trace.inputSha256 === "string" && /^[a-f0-9]{64}$/.test(trace.inputSha256)
    && typeof trace.querySha256 === "string" && /^[a-f0-9]{64}$/.test(trace.querySha256)
    && (trace.packId === undefined || typeof trace.packId === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(trace.packId))
    && (trace.packVersion === undefined || typeof trace.packVersion === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(trace.packVersion))
    && (trace.modelMode === undefined || ["automatic", "general", "custom"].includes(String(trace.modelMode)))
    && (trace.modelId === undefined || typeof trace.modelId === "string" && trace.modelId.length > 0 && trace.modelId.length <= 120)
    && (!hasPackProvenance || trace.packId !== undefined && trace.packVersion !== undefined)
    && (!hasModelProvenance || trace.modelMode !== undefined && trace.modelId !== undefined && hasPackProvenance);
}

export function parseAnalysisTraceHeader(value: string | null) {
  if (!value || value.length > 30_000) return null;
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(value));
    return isValidAnalysisTrace(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parsePackWarningsHeader(value: string | null): ChatMessage["answerDisposition"] | null {
  if (!value || value.length > 256) return null;
  const codes = value.split(",").map((code) => code.trim());
  if (codes.length === 0 || codes.length > 2 || new Set(codes).size !== codes.length
    || !codes.every((code) => expertPackWarningCodes.includes(code as ExpertPackWarningCode))) return null;
  return "verified-fallback";
}

function validOptionalMetadata(message: Record<string, unknown>) {
  if (!Object.keys(message).every((key) => messageKeys.has(key))) return false;
  if (message.artifactIntent !== undefined && message.artifactIntent !== "word") return false;
  if (message.retrievalMode !== undefined && !["hybrid", "keyword-only"].includes(String(message.retrievalMode))) return false;
  if (message.memoryUse !== undefined && !["context", "direct"].includes(String(message.memoryUse))) return false;
  if (message.answerDisposition !== undefined) {
    if (message.answerDisposition !== "verified-fallback" || message.role !== "assistant"
      || !isValidAnalysisTrace(message.analysisTrace)
      || !message.analysisTrace.packId) return false;
  }
  if (message.memoryTitles !== undefined && (!Array.isArray(message.memoryTitles)
    || message.memoryTitles.length > 8
    || !message.memoryTitles.every((title) => typeof title === "string" && title.length > 0 && title.length <= 80))) return false;
  if (message.replyTo !== undefined) {
    if (!message.replyTo || typeof message.replyTo !== "object") return false;
    const reply = message.replyTo as Record<string, unknown>;
    if (!Object.keys(reply).every((key) => key === "role" || key === "excerpt")
      || !["user", "assistant"].includes(String(reply.role))
      || typeof reply.excerpt !== "string" || reply.excerpt.length > 500) return false;
  }
  if (message.codeContext !== undefined) {
    if (!message.codeContext || typeof message.codeContext !== "object") return false;
    const code = message.codeContext as Record<string, unknown>;
    if (!Object.keys(code).every((key) => ["repository", "path", "startLine", "endLine"].includes(key))
      || typeof code.repository !== "string" || code.repository.length > 240
      || typeof code.path !== "string" || code.path.length > 1024
      || typeof code.startLine !== "number" || !Number.isInteger(code.startLine)
      || typeof code.endLine !== "number" || !Number.isInteger(code.endLine)) return false;
  }
  if (message.wordArtifact !== undefined) {
    if (!message.wordArtifact || typeof message.wordArtifact !== "object") return false;
    const artifact = message.wordArtifact as Record<string, unknown>;
    if (!Object.keys(artifact).every((key) => ["id", "title", "filename", "previewPages"].includes(key))
      || typeof artifact.id !== "string" || artifact.id.length > 80
      || typeof artifact.title !== "string" || artifact.title.length > 240
      || typeof artifact.filename !== "string" || artifact.filename.length > 240
      || typeof artifact.previewPages !== "number" || !Number.isInteger(artifact.previewPages)
      || artifact.previewPages < 0 || artifact.previewPages > 1000) return false;
  }
  if (message.analysisTrace !== undefined) {
    if (!isValidAnalysisTrace(message.analysisTrace)) return false;
  }
  return true;
}

export function isValidChatMessages(value: unknown, options: { allowEmpty?: boolean } = {}): value is ChatMessage[] {
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0) || value.length > MAX_CHAT_MESSAGES) return false;
  let totalCharacters = 0;
  return value.every((message) => {
    if (!isValidChatMessage(message)) return false;
    const candidate = message as ChatMessage;
    totalCharacters += candidate.content.length;
    return totalCharacters <= MAX_CHAT_TOTAL_CHARS;
  });
}

export function isValidChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ChatMessage>;
  return ["user", "assistant", "system"].includes(candidate.role ?? "")
    && typeof candidate.content === "string"
    && Boolean(candidate.content.trim())
    && candidate.content.length <= MAX_CHAT_MESSAGE_CHARS
    && validOptionalMetadata(value as Record<string, unknown>);
}
