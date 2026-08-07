import type { Conversation } from "./conversations";
import type { ChatMessage } from "./providers/types";
import { isValidChatMessage } from "./chat-validation.ts";

const markerPrefix = "rangabot-conversation:v";
export const MAX_CONVERSATION_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_CONVERSATION_IMPORT_MESSAGES = 500;

type ConversationPayload = { version: 1 | 2; messages: ChatMessage[] };

function readableRole(role: ChatMessage["role"]) {
  if (role === "user") return "You";
  if (role === "assistant") return "Rangabot";
  return "System";
}

function portableMessage(message: ChatMessage): ChatMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
  };
}

export function serializeConversationMarkdown(conversation: Conversation) {
  const messages = conversation.messages
    .filter((message) => message.role !== "system")
    .map(portableMessage);
  if (messages.length === 0 || messages.length > MAX_CONVERSATION_IMPORT_MESSAGES
    || !messages.every((message) => isValidChatMessage(message) && message.role !== "system")) {
    throw new Error("Conversation exports must contain between 1 and 500 portable messages.");
  }
  const payload: ConversationPayload = { version: 2, messages };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const transcript = messages.map((message) => {
    const reply = message.replyTo
      ? `\n> Replying to ${readableRole(message.replyTo.role)}: ${message.replyTo.excerpt.replace(/\n/g, " ")}\n`
      : "";
    return `## ${readableRole(message.role)}\n${reply}\n${message.content.trim()}\n`;
  }).join("\n");
  return `<!-- ${markerPrefix}2:${encoded} -->\n\n# ${conversation.title}\n\n_Exported locally from Rangabot on ${conversation.updatedAt}._\n\n${transcript}`;
}

export function parseConversationMarkdown(markdown: string): ChatMessage[] {
  if (Buffer.byteLength(markdown, "utf8") > MAX_CONVERSATION_IMPORT_BYTES) throw new Error("Conversation file exceeds the 2 MB limit.");
  const match = markdown.match(new RegExp(`<!--\\s*${markerPrefix}([12]):([A-Za-z0-9_-]+)\\s*-->`));
  if (!match) throw new Error("This is not a Rangabot conversation export.");
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(match[2], "base64url").toString("utf8"));
  } catch {
    throw new Error("The Rangabot conversation payload is damaged.");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("The Rangabot conversation payload is invalid.");
  }
  const payload = decoded as ConversationPayload;
  const markerVersion = Number(match[1]);
  if (payload.version !== markerVersion || !Array.isArray(payload.messages)
    || !payload.messages.every((message) => isValidChatMessage(message))
    || (payload.version === 2 && payload.messages.some((message) => message.role === "system"))) {
    throw new Error("The Rangabot conversation payload is invalid.");
  }
  const messages = payload.messages.filter((message) => message.role !== "system").map(portableMessage);
  if (messages.length === 0 || messages.length > MAX_CONVERSATION_IMPORT_MESSAGES) {
    throw new Error("Conversation exports must contain between 1 and 500 portable messages.");
  }
  return messages;
}

export function conversationFilename(title: string) {
  const safe = title.normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60).toLowerCase();
  return `${safe || "rangabot-conversation"}.md`;
}
