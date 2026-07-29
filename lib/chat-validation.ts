import type { ChatMessage } from "./providers/types";

export const MAX_CHAT_MESSAGES = 200;
export const MAX_CHAT_MESSAGE_CHARS = 50_000;
export const MAX_CHAT_TOTAL_CHARS = 1_000_000;
const messageKeys = new Set(["role", "content", "artifactIntent", "wordArtifact", "codeContext", "replyTo", "retrievalMode"]);

function validOptionalMetadata(message: Record<string, unknown>) {
  if (!Object.keys(message).every((key) => messageKeys.has(key))) return false;
  if (message.artifactIntent !== undefined && message.artifactIntent !== "word") return false;
  if (message.retrievalMode !== undefined && !["hybrid", "keyword-only"].includes(String(message.retrievalMode))) return false;
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
  return true;
}

export function isValidChatMessages(value: unknown, options: { allowEmpty?: boolean } = {}): value is ChatMessage[] {
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0) || value.length > MAX_CHAT_MESSAGES) return false;
  let totalCharacters = 0;
  return value.every((message) => {
    if (!message || typeof message !== "object") return false;
    const candidate = message as Partial<ChatMessage>;
    if (!["user", "assistant", "system"].includes(candidate.role ?? "") || typeof candidate.content !== "string") return false;
    if (!candidate.content.trim()) return false;
    if (candidate.content.length > MAX_CHAT_MESSAGE_CHARS) return false;
    if (!validOptionalMetadata(message as Record<string, unknown>)) return false;
    totalCharacters += candidate.content.length;
    return totalCharacters <= MAX_CHAT_TOTAL_CHARS;
  });
}
