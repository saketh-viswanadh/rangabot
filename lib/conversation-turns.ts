import { createHash, randomUUID } from "node:crypto";
import { isValidChatMessage, MAX_CHAT_MESSAGES, MAX_CHAT_MESSAGE_CHARS, MAX_CHAT_TOTAL_CHARS } from "./chat-validation.ts";
import type { CodeContextRequest } from "./code-context.ts";
import { CONVERSATION_TURN_PROTOCOL_VERSION } from "./conversation-turn-contract.ts";
import { getConversation, getConversationDatabase, titleFromMessages, type Conversation } from "./conversations.ts";
import type { ExpertPackFailureCode } from "./expert-packs.ts";
import type { ChatMessage, ConversationTurnStatus, ProviderFailureCode } from "./providers/types.ts";

export { CONVERSATION_TURN_PROTOCOL_VERSION };
// Longer than the maximum configurable 15-minute absolute deadline, so a
// legitimate live generation cannot be reaped by a concurrent timeline read.
export const CONVERSATION_TURN_STALE_MS = 16 * 60 * 1000;

export type ConversationMode = "local" | "smart" | "teach" | "codex";
export type ConversationTurnFailureCode = ProviderFailureCode | ExpertPackFailureCode | "invalid-request" | "internal" | "interrupted";

export type ConversationTurnOptions = {
  mode: ConversationMode;
  codeContext?: CodeContextRequest;
};

type StoredTurnOptions = ConversationTurnOptions & { datasetId: string | null; projectId: string | null };

export type ConversationTurn = {
  id: string;
  conversationId: string;
  sequence: number;
  status: ConversationTurnStatus;
  requestHash: string;
  userMessage: ChatMessage;
  options: StoredTurnOptions;
  assistantMessage: ChatMessage | null;
  failureCode: string | null;
  failureMessage: string | null;
  contextMessageCount: number;
  executionStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

type TurnRow = {
  id: string;
  conversationId: string;
  sequence: number;
  status: ConversationTurnStatus;
  requestHash: string;
  userMessage: string;
  requestOptions: string;
  assistantMessage: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  contextMessageCount: number;
  executionStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type BeginConversationTurnInput = {
  id: string;
  conversationId?: string;
  projectId?: string | null;
  datasetId?: string | null;
  userMessage: ChatMessage;
  options: ConversationTurnOptions;
};

export type ClaimedConversationTurn = {
  kind: "claimed";
  turn: ConversationTurn;
  messages: ChatMessage[];
};

export type ConversationTurnClaim = ClaimedConversationTurn | {
  kind: "completed" | "terminal" | "in-progress";
  turn: ConversationTurn;
};

export type ConversationTurnErrorCode = "invalid" | "not-found" | "conflict" | "turn-in-progress" | "integrity";

export class ConversationTurnError extends Error {
  readonly code: ConversationTurnErrorCode;
  constructor(code: ConversationTurnErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "ConversationTurnError";
  }
}

export function isValidConversationTurnId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isValidConversationMode(value: unknown): value is ConversationMode {
  return value === "local" || value === "smart" || value === "teach" || value === "codex";
}

export function isValidTurnUserMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (!Object.keys(message).every((key) => ["role", "content", "replyTo", "codeContext"].includes(key))) return false;
  if (message.role !== "user" || typeof message.content !== "string" || !message.content.trim() || message.content.length > 50_000) return false;
  if (message.replyTo !== undefined) {
    if (!message.replyTo || typeof message.replyTo !== "object" || Array.isArray(message.replyTo)) return false;
    const reply = message.replyTo as Record<string, unknown>;
    if (!Object.keys(reply).every((key) => key === "role" || key === "excerpt")
      || (reply.role !== "user" && reply.role !== "assistant")
      || typeof reply.excerpt !== "string" || reply.excerpt.length > 500) return false;
  }
  if (message.codeContext !== undefined) {
    if (!message.codeContext || typeof message.codeContext !== "object" || Array.isArray(message.codeContext)) return false;
    const context = message.codeContext as Record<string, unknown>;
    if (!Object.keys(context).every((key) => ["repository", "path", "startLine", "endLine"].includes(key))
      || typeof context.repository !== "string" || !context.repository.trim() || context.repository.length > 240
      || typeof context.path !== "string" || !context.path.trim() || context.path.length > 1024
      || typeof context.startLine !== "number" || !Number.isInteger(context.startLine) || context.startLine < 1
      || typeof context.endLine !== "number" || !Number.isInteger(context.endLine) || context.endLine < context.startLine) return false;
  }
  return true;
}

function normalizeUserMessage(message: ChatMessage): ChatMessage {
  return {
    role: "user",
    content: message.content.trim(),
    ...(message.replyTo ? { replyTo: { role: message.replyTo.role, excerpt: message.replyTo.excerpt.slice(0, 500) } } : {}),
    ...(message.codeContext ? { codeContext: {
      repository: message.codeContext.repository,
      path: message.codeContext.path,
      startLine: message.codeContext.startLine,
      endLine: message.codeContext.endLine,
    } } : {}),
  };
}

function normalizeOptions(options: ConversationTurnOptions, datasetId: string | null, projectId: string | null): StoredTurnOptions {
  return {
    mode: options.mode,
    ...(options.codeContext ? { codeContext: {
      repositoryId: options.codeContext.repositoryId,
      path: options.codeContext.path,
      line: options.codeContext.line,
    } } : {}),
    datasetId,
    projectId,
  };
}

function requestHash(message: ChatMessage, options: StoredTurnOptions) {
  return createHash("sha256").update(JSON.stringify({ message, options })).digest("hex");
}

function parseTurn(row: TurnRow): ConversationTurn {
  return {
    ...row,
    userMessage: JSON.parse(row.userMessage) as ChatMessage,
    options: JSON.parse(row.requestOptions) as StoredTurnOptions,
    assistantMessage: row.assistantMessage ? JSON.parse(row.assistantMessage) as ChatMessage : null,
  };
}

function getTurnRow(id: string): TurnRow | null {
  return (getConversationDatabase().prepare(`
    SELECT id, conversation_id AS conversationId, sequence, status, request_hash AS requestHash,
      user_message AS userMessage, request_options AS requestOptions, assistant_message AS assistantMessage,
      failure_code AS failureCode, failure_message AS failureMessage,
      context_message_count AS contextMessageCount, execution_started_at AS executionStartedAt,
      created_at AS createdAt, updated_at AS updatedAt, finished_at AS finishedAt
    FROM conversation_turns WHERE id = ?
  `).get(id) as unknown as TurnRow | undefined) ?? null;
}

export function getConversationTurn(id: string): ConversationTurn | null {
  const row = getTurnRow(id);
  return row ? parseTurn(row) : null;
}

export function listConversationTurns(conversationId: string): ConversationTurn[] {
  const rows = getConversationDatabase().prepare(`
    SELECT id, conversation_id AS conversationId, sequence, status, request_hash AS requestHash,
      user_message AS userMessage, request_options AS requestOptions, assistant_message AS assistantMessage,
      failure_code AS failureCode, failure_message AS failureMessage,
      context_message_count AS contextMessageCount, execution_started_at AS executionStartedAt,
      created_at AS createdAt, updated_at AS updatedAt, finished_at AS finishedAt
    FROM conversation_turns WHERE conversation_id = ? ORDER BY sequence ASC
  `).all(conversationId) as unknown as TurnRow[];
  return rows.map(parseTurn);
}

function withImmediateTransaction<T>(run: () => T): T {
  const database = getConversationDatabase();
  database.exec("BEGIN IMMEDIATE");
  try {
    const value = run();
    database.exec("COMMIT");
    return value;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function beginConversationTurn(input: BeginConversationTurnInput): { turn: ConversationTurn; conversationId: string; replayed: boolean } {
  if (!isValidConversationTurnId(input.id) || !isValidTurnUserMessage(input.userMessage) || !isValidConversationMode(input.options.mode)) {
    throw new ConversationTurnError("invalid", "A valid turn id, user message, and mode are required.");
  }
  const userMessage = normalizeUserMessage(input.userMessage);
  recoverExpiredConversationTurns();
  return withImmediateTransaction(() => {
    const database = getConversationDatabase();
    const existing = getTurnRow(input.id);
    if (existing) {
      const turn = parseTurn(existing);
      const requestedDataset = input.conversationId ? turn.options.datasetId : input.datasetId ?? null;
      const requestedProject = input.conversationId ? turn.options.projectId : input.projectId ?? null;
      const hash = requestHash(userMessage, normalizeOptions(input.options, requestedDataset, requestedProject));
      if ((input.conversationId && input.conversationId !== turn.conversationId) || hash !== turn.requestHash) {
        throw new ConversationTurnError("conflict", "That turn id is already bound to a different request.");
      }
      return { turn, conversationId: turn.conversationId, replayed: true };
    }

    let conversationId = input.conversationId;
    let conversation = conversationId ? getConversation(conversationId) : null;
    const now = new Date().toISOString();
    if (conversationId && !conversation) throw new ConversationTurnError("not-found", "Conversation not found.");
    if (!conversation) {
      conversationId = randomUUID();
      database.prepare(`
        INSERT INTO conversations (id, title, messages, project_id, dataset_id, pinned, created_at, updated_at)
        VALUES (?, ?, '[]', ?, ?, 0, ?, ?)
      `).run(conversationId, "New conversation", input.projectId ?? null, input.datasetId ?? null, now, now);
      conversation = getConversation(conversationId);
    }
    if (!conversationId || !conversation) throw new ConversationTurnError("integrity", "Could not create the local conversation.");

    const pending = database.prepare("SELECT id FROM conversation_turns WHERE conversation_id = ? AND status = 'pending' LIMIT 1").get(conversationId) as { id: string } | undefined;
    if (pending) throw new ConversationTurnError("turn-in-progress", "This conversation already has a turn in progress.");

    const sequenceRow = database.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM conversation_turns WHERE conversation_id = ?").get(conversationId) as { sequence: number };
    const options = normalizeOptions(input.options, conversation.datasetId, conversation.projectId);
    const hash = requestHash(userMessage, options);
    database.prepare(`
      INSERT INTO conversation_turns (
        id, conversation_id, sequence, status, request_hash, user_message, request_options,
        context_message_count, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
    `).run(input.id, conversationId, sequenceRow.sequence, hash, JSON.stringify(userMessage), JSON.stringify(options), conversation.messages.length, now, now);
    database.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now, conversationId);
    const turn = getConversationTurn(input.id);
    if (!turn) throw new ConversationTurnError("integrity", "The local turn could not be read after creation.");
    return { turn, conversationId, replayed: false };
  });
}

function withoutTurnMetadata(message: ChatMessage): ChatMessage {
  const { turn: _turn, ...portable } = message;
  return portable;
}

function messageForPrompt(message: ChatMessage): ChatMessage {
  const portable = withoutTurnMetadata(message);
  if (!portable.replyTo) return portable;
  const prefix = `[Replying to ${portable.replyTo.role}: “${portable.replyTo.excerpt}”]\n\n`;
  return prefix.length + portable.content.length <= MAX_CHAT_MESSAGE_CHARS
    ? { ...portable, content: `${prefix}${portable.content}` }
    : portable;
}

/** Keep the newest coherent completed context inside the public chat limits. */
export function buildBoundedPromptMessages(history: ChatMessage[], currentUser: ChatMessage): ChatMessage[] {
  const user = messageForPrompt(currentUser);
  let remainingCharacters = Math.max(0, MAX_CHAT_TOTAL_CHARS - user.content.length);
  const selected: ChatMessage[] = [];
  const portableHistory = history.filter((message) => message.role !== "system").map(messageForPrompt);
  for (let index = portableHistory.length - 1; index >= 0 && selected.length < MAX_CHAT_MESSAGES - 1; index -= 1) {
    const message = portableHistory[index];
    if (message.content.length > remainingCharacters) break;
    selected.unshift(message);
    remainingCharacters -= message.content.length;
  }
  while (selected[0]?.role === "assistant") selected.shift();
  return [...selected, user];
}

export function claimConversationTurn(conversationId: string, turnId: string): ConversationTurnClaim {
  return withImmediateTransaction(() => {
    const database = getConversationDatabase();
    const row = getTurnRow(turnId);
    if (!row || row.conversationId !== conversationId) throw new ConversationTurnError("not-found", "Conversation turn not found.");
    const turn = parseTurn(row);
    if (turn.status === "completed") return { kind: "completed", turn };
    if (turn.status === "cancelled" || turn.status === "failed") return { kind: "terminal", turn };
    if (turn.executionStartedAt) return { kind: "in-progress", turn };
    const conversation = getConversation(conversationId);
    if (!conversation || conversation.messages.length !== turn.contextMessageCount) {
      throw new ConversationTurnError("integrity", "Conversation history changed after this turn began.");
    }
    const executionStartedAt = new Date().toISOString();
    const result = database.prepare(`
      UPDATE conversation_turns SET execution_started_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending' AND execution_started_at IS NULL
    `).run(executionStartedAt, executionStartedAt, turnId);
    if (result.changes !== 1) throw new ConversationTurnError("turn-in-progress", "This turn is already being processed.");
    const claimed = getConversationTurn(turnId);
    if (!claimed) throw new ConversationTurnError("integrity", "Claimed turn could not be reloaded.");
    return { kind: "claimed", turn: claimed, messages: buildBoundedPromptMessages(conversation.messages, claimed.userMessage) };
  });
}

function sameMessage(left: ChatMessage | null, right: ChatMessage) {
  return left ? JSON.stringify(withoutTurnMetadata(left)) === JSON.stringify(withoutTurnMetadata(right)) : false;
}

export function completeConversationTurn(turnId: string, assistantMessage: ChatMessage): ConversationTurn {
  const portableAssistant = withoutTurnMetadata({ ...assistantMessage, content: assistantMessage.content.trim() });
  if (portableAssistant.role !== "assistant" || !isValidChatMessage(portableAssistant)) {
    throw new ConversationTurnError("invalid", "A valid non-empty assistant message is required to complete a turn.");
  }
  return withImmediateTransaction(() => {
    const database = getConversationDatabase();
    const row = getTurnRow(turnId);
    if (!row) throw new ConversationTurnError("not-found", "Conversation turn not found.");
    const turn = parseTurn(row);
    if (turn.status === "completed") {
      if (!sameMessage(turn.assistantMessage, portableAssistant)) throw new ConversationTurnError("conflict", "Completed turn content cannot be replaced.");
      return turn;
    }
    if (turn.status !== "pending") throw new ConversationTurnError("conflict", "A terminal turn cannot be completed again.");
    const conversation = getConversation(turn.conversationId);
    if (!conversation || conversation.messages.length !== turn.contextMessageCount) {
      throw new ConversationTurnError("integrity", "Conversation history changed before completion.");
    }
    const receipt = { id: turn.id, status: "completed" as const };
    const canonicalMessages: ChatMessage[] = [
      ...conversation.messages,
      { ...turn.userMessage, turn: receipt },
      { ...portableAssistant, turn: receipt },
    ];
    const now = new Date().toISOString();
    const updated = database.prepare(`
      UPDATE conversation_turns
      SET status = 'completed', assistant_message = ?, failure_code = NULL, failure_message = NULL,
        updated_at = ?, finished_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(JSON.stringify(portableAssistant), now, now, turnId);
    if (updated.changes !== 1) throw new ConversationTurnError("conflict", "Another terminal transition won this turn.");
    database.prepare("UPDATE conversations SET title = ?, messages = ?, updated_at = ? WHERE id = ?")
      .run(titleFromMessages(canonicalMessages), JSON.stringify(canonicalMessages), now, turn.conversationId);
    const completed = getConversationTurn(turnId);
    if (!completed) throw new ConversationTurnError("integrity", "Completed turn could not be reloaded.");
    return completed;
  });
}

function terminalizeTurn(
  turnId: string,
  status: "cancelled" | "failed",
  failureCode: ConversationTurnFailureCode,
  failureMessage: string,
  partialAssistant?: ChatMessage | null,
) {
  return withImmediateTransaction(() => {
    const database = getConversationDatabase();
    const row = getTurnRow(turnId);
    if (!row) throw new ConversationTurnError("not-found", "Conversation turn not found.");
    const turn = parseTurn(row);
    const partialContent = partialAssistant?.content.trim().slice(0, MAX_CHAT_MESSAGE_CHARS);
    const partial = partialContent
      ? withoutTurnMetadata({ ...partialAssistant, role: "assistant", content: partialContent })
      : null;
    if (turn.status !== "pending") {
      // An explicit Stop request can beat stream-abort propagation. Allow the
      // server-side stream wrapper to enrich that same cancelled receipt with
      // the partial text it already observed, without reopening the turn.
      if (turn.status === "cancelled" && status === "cancelled" && partial && !turn.assistantMessage) {
        const updatedAt = new Date().toISOString();
        database.prepare(`
          UPDATE conversation_turns SET assistant_message = ?, updated_at = ?
          WHERE id = ? AND status = 'cancelled' AND assistant_message IS NULL
        `).run(JSON.stringify(partial), updatedAt, turnId);
        return getConversationTurn(turnId) ?? turn;
      }
      return turn;
    }
    const now = new Date().toISOString();
    database.prepare(`
      UPDATE conversation_turns
      SET status = ?, assistant_message = ?, failure_code = ?, failure_message = ?,
        updated_at = ?, finished_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(status, partial ? JSON.stringify(partial) : null, failureCode, failureMessage.slice(0, 500), now, now, turnId);
    database.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now, turn.conversationId);
    return getConversationTurn(turnId) ?? turn;
  });
}

export function cancelConversationTurn(turnId: string, partialAssistant?: ChatMessage | null) {
  return terminalizeTurn(turnId, "cancelled", "cancelled", "Generation was stopped.", partialAssistant);
}

export function failConversationTurn(turnId: string, code: ConversationTurnFailureCode, message: string, partialAssistant?: ChatMessage | null) {
  return terminalizeTurn(turnId, "failed", code, message || "The local request failed.", partialAssistant);
}

export function recoverExpiredConversationTurns(now = Date.now(), maxAgeMs = CONVERSATION_TURN_STALE_MS) {
  const stale = getConversationDatabase().prepare(`
    SELECT id FROM conversation_turns
    WHERE status = 'pending' AND COALESCE(execution_started_at, created_at) < ?
  `).all(new Date(now - maxAgeMs).toISOString()) as { id: string }[];
  for (const row of stale) failConversationTurn(row.id, "interrupted", "The earlier local generation was interrupted before completion.");
  return stale.length;
}

export function getConversationTimeline(id: string): Conversation | null {
  recoverExpiredConversationTurns();
  const conversation = getConversation(id);
  if (!conversation) return null;
  const turns = listConversationTurns(id);
  if (!turns.length) return conversation;
  const legacy = conversation.messages.slice(0, turns[0].contextMessageCount).map(withoutTurnMetadata);
  const messages: ChatMessage[] = [...legacy];
  for (const turn of turns) {
    const receipt = { id: turn.id, status: turn.status, ...(turn.failureCode ? { failureCode: turn.failureCode } : {}) };
    messages.push({ ...turn.userMessage, turn: receipt });
    if (turn.status === "pending") continue;
    const fallback = turn.status === "cancelled"
      ? "No response was generated."
      : turn.failureMessage || "The local request failed.";
    messages.push({ ...(turn.assistantMessage ?? { role: "assistant", content: fallback }), role: "assistant", turn: receipt });
  }
  return { ...conversation, messages };
}
