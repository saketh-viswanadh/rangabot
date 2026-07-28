import type { Conversation } from "./conversations";
import type { ChatMessage } from "./providers/types";

const marker = "rangabot-conversation:v1:";
export const MAX_CONVERSATION_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_CONVERSATION_IMPORT_MESSAGES = 500;

type ConversationPayload = { version: 1; messages: ChatMessage[] };

function readableRole(role: ChatMessage["role"]) {
  if (role === "user") return "You";
  if (role === "assistant") return "Rangabot";
  return "System";
}

export function serializeConversationMarkdown(conversation: Conversation) {
  const payload: ConversationPayload = { version: 1, messages: conversation.messages };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const transcript = conversation.messages.map((message) => {
    const reply = message.replyTo
      ? `\n> Replying to ${readableRole(message.replyTo.role)}: ${message.replyTo.excerpt.replace(/\n/g, " ")}\n`
      : "";
    return `## ${readableRole(message.role)}\n${reply}\n${message.content.trim()}\n`;
  }).join("\n");
  return `<!-- ${marker}${encoded} -->\n\n# ${conversation.title}\n\n_Exported locally from Rangabot on ${conversation.updatedAt}._\n\n${transcript}`;
}

function validMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as ChatMessage;
  if (!["user", "assistant", "system"].includes(message.role) || typeof message.content !== "string") return false;
  if (!message.replyTo) return true;
  return ["user", "assistant"].includes(message.replyTo.role) && typeof message.replyTo.excerpt === "string";
}

export function parseConversationMarkdown(markdown: string): ChatMessage[] {
  if (Buffer.byteLength(markdown, "utf8") > MAX_CONVERSATION_IMPORT_BYTES) throw new Error("Conversation file exceeds the 2 MB limit.");
  const match = markdown.match(new RegExp(`<!--\\s*${marker}([A-Za-z0-9_-]+)\\s*-->`));
  if (!match) throw new Error("This is not a Rangabot conversation export.");
  let payload: ConversationPayload;
  try {
    payload = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")) as ConversationPayload;
  } catch {
    throw new Error("The Rangabot conversation payload is damaged.");
  }
  if (payload.version !== 1 || !Array.isArray(payload.messages) || !payload.messages.every(validMessage)) {
    throw new Error("The Rangabot conversation payload is invalid.");
  }
  if (payload.messages.length === 0 || payload.messages.length > MAX_CONVERSATION_IMPORT_MESSAGES) {
    throw new Error("Conversation exports must contain between 1 and 500 messages.");
  }
  return payload.messages;
}

export function conversationFilename(title: string) {
  const safe = title.normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60).toLowerCase();
  return `${safe || "rangabot-conversation"}.md`;
}
