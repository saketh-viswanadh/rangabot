import { createHash, randomUUID } from "node:crypto";
import { isValidChatMessage, MAX_CHAT_MESSAGES, MAX_CHAT_MESSAGE_CHARS, MAX_CHAT_TOTAL_CHARS } from "./chat-validation.ts";
import type { CodeContextRequest } from "./code-context.ts";
import { CONVERSATION_TURN_PROTOCOL_VERSION } from "./conversation-turn-contract.ts";
import { getConversation, getConversationDatabase, titleFromMessages, type Conversation } from "./conversations.ts";
import { getApprovedDataset } from "./datasets.ts";
import type { ExpertPackFailureCode } from "./expert-packs.ts";
import type { ChatMessage, ConversationTurnStatus, ProviderFailureCode } from "./providers/types.ts";
import { getRuntimeResponseFeedbackCandidate } from "./response-feedback-candidate.ts";
import { recordCompletedResponseFeedback } from "./response-feedback.ts";

export { CONVERSATION_TURN_PROTOCOL_VERSION };
// Longer than the maximum configurable 15-minute absolute deadline, so a
// legitimate live generation cannot be reaped by a concurrent timeline read.
export const CONVERSATION_TURN_STALE_MS = 16 * 60 * 1000;

export type ConversationMode = "local" | "smart" | "teach" | "codex";
export type ConversationTurnFailureCode = ProviderFailureCode | ExpertPackFailureCode | "invalid-request" | "internal" | "interrupted";

export type RecoveryTurnBinding = {
  sourceTurnId: string;
  conversationId: string;
  projectId: string | null;
  datasetId: string | null;
  datasetSha256: string | null;
  contextMessageCount: number;
};

export type ConversationContextBinding = {
  projectId: string | null;
  datasetId: string | null;
  datasetSha256: string | null;
  contextMessageCount: number;
};

/**
 * A stored dataset id is only an executable conversation binding while its
 * exact approval still exists. Keep the row for explicit user reconciliation,
 * but never advertise or inherit a revoked approval into a new turn.
 */
export function conversationContextBinding(conversation: Conversation): ConversationContextBinding {
  const dataset = conversation.datasetId ? getApprovedDataset(conversation.datasetId) : null;
  return {
    projectId: conversation.projectId,
    datasetId: dataset ? conversation.datasetId : null,
    datasetSha256: dataset?.fileIdentity.sha256 ?? null,
    contextMessageCount: conversation.messages.length,
  };
}

export type ConversationTurnOptions = {
  mode: ConversationMode;
  codeContext?: CodeContextRequest;
  datasetSha256?: string;
  recoveryBinding?: RecoveryTurnBinding;
};

export type StoredConversationTurnOptions = Omit<ConversationTurnOptions, "datasetSha256" | "recoveryBinding"> & {
  datasetId: string | null;
  datasetSha256?: string | null;
  projectId: string | null;
};

export type ConversationTurn = {
  id: string;
  conversationId: string;
  sequence: number;
  status: ConversationTurnStatus;
  requestHash: string;
  userMessage: ChatMessage;
  options: StoredConversationTurnOptions;
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
  expectedConversationBinding?: ConversationContextBinding;
  userMessage: ChatMessage;
  options: ConversationTurnOptions;
};

export type ClaimedConversationTurn = {
  kind: "claimed";
  turn: ConversationTurn;
  messages: ChatMessage[];
  candidateBuildId: string | null;
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

export function isValidRecoveryTurnBinding(value: unknown): value is RecoveryTurnBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  if (!Object.keys(binding).every((key) => ["sourceTurnId", "conversationId", "projectId", "datasetId", "datasetSha256", "contextMessageCount"].includes(key))
    || Object.keys(binding).length !== 6
    || !isValidConversationTurnId(binding.sourceTurnId) || !isValidConversationTurnId(binding.conversationId)
    || binding.projectId !== null && (typeof binding.projectId !== "string" || !binding.projectId || binding.projectId.length > 120)
    || binding.datasetId !== null && (typeof binding.datasetId !== "string" || !binding.datasetId || binding.datasetId.length > 120)
    || !Number.isSafeInteger(binding.contextMessageCount) || Number(binding.contextMessageCount) < 0) return false;
  return binding.datasetId === null
    ? binding.datasetSha256 === null
    : typeof binding.datasetSha256 === "string" && /^[a-f0-9]{64}$/.test(binding.datasetSha256);
}

export function isValidConversationContextBinding(value: unknown): value is ConversationContextBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  if (Object.keys(binding).length !== 4
    || !Object.keys(binding).every((key) => ["projectId", "datasetId", "datasetSha256", "contextMessageCount"].includes(key))
    || binding.projectId !== null && (typeof binding.projectId !== "string" || !binding.projectId || binding.projectId.length > 120)
    || binding.datasetId !== null && (typeof binding.datasetId !== "string" || !binding.datasetId || binding.datasetId.length > 120)
    || !Number.isSafeInteger(binding.contextMessageCount) || Number(binding.contextMessageCount) < 0) return false;
  return binding.datasetId === null
    ? binding.datasetSha256 === null
    : typeof binding.datasetSha256 === "string" && /^[a-f0-9]{64}$/.test(binding.datasetSha256);
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

function normalizeOptions(options: ConversationTurnOptions, datasetId: string | null, projectId: string | null): StoredConversationTurnOptions {
  const dataset = datasetId ? getApprovedDataset(datasetId) : null;
  if (options.datasetSha256 && dataset?.fileIdentity.sha256 !== options.datasetSha256) {
    throw new ConversationTurnError("conflict", "The attached dataset changed after recovery. Review and attach it again before sending.");
  }
  return {
    mode: options.mode,
    ...(options.codeContext ? { codeContext: {
      repositoryId: options.codeContext.repositoryId,
      path: options.codeContext.path,
      line: options.codeContext.line,
      ...(options.codeContext.previewSha256 ? { previewSha256: options.codeContext.previewSha256 } : {}),
    } } : {}),
    datasetId: dataset ? datasetId : null,
    datasetSha256: dataset?.fileIdentity.sha256 ?? null,
    projectId,
  };
}

export function conversationTurnRequestHash(message: ChatMessage, options: unknown) {
  return createHash("sha256").update(JSON.stringify({ message, options })).digest("hex");
}

function parseTurn(row: TurnRow): ConversationTurn {
  return {
    ...row,
    userMessage: JSON.parse(row.userMessage) as ChatMessage,
    options: JSON.parse(row.requestOptions) as StoredConversationTurnOptions,
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
  if (!isValidConversationTurnId(input.id) || !isValidTurnUserMessage(input.userMessage) || !isValidConversationMode(input.options.mode)
    || (input.options.recoveryBinding !== undefined && !isValidRecoveryTurnBinding(input.options.recoveryBinding))
    // The HTTP admission boundary requires this receipt for every existing
    // conversation. Keeping it optional here preserves the lower-level
    // lifecycle API used by migrations and isolated persistence tests, while
    // any supplied receipt is still compared inside the same transaction.
    || (input.expectedConversationBinding !== undefined && !isValidConversationContextBinding(input.expectedConversationBinding))
    || (input.conversationId === undefined && input.expectedConversationBinding !== undefined)) {
    throw new ConversationTurnError("invalid", "A valid turn id, user message, and mode are required.");
  }
  const userMessage = normalizeUserMessage(input.userMessage);
  recoverExpiredConversationTurns();
  return withImmediateTransaction(() => {
    const database = getConversationDatabase();
    const existing = getTurnRow(input.id);
    if (existing) {
      let turn = parseTurn(existing);
      const boundConversation = getConversation(turn.conversationId);
      if (!boundConversation) throw new ConversationTurnError("integrity", "The turn's conversation is missing.");
      const boundConversationBinding = conversationContextBinding(boundConversation);
      const requestedDataset = input.conversationId ? boundConversationBinding.datasetId : input.datasetId ?? null;
      const requestedProject = input.conversationId ? boundConversation.projectId : input.projectId ?? null;
      const normalizedOptions = normalizeOptions(input.options, requestedDataset, requestedProject);
      const hash = conversationTurnRequestHash(userMessage, normalizedOptions);
      const storedOptions = JSON.parse(existing.requestOptions) as Record<string, unknown>;
      const compatibleOptions = { ...normalizedOptions } as Record<string, unknown>;
      const missingDatasetReceipt = !Object.prototype.hasOwnProperty.call(storedOptions, "datasetSha256");
      if (missingDatasetReceipt) delete compatibleOptions.datasetSha256;
      if (!Object.prototype.hasOwnProperty.call(storedOptions, "projectId")) delete compatibleOptions.projectId;
      const canUpgradeLegacyHash = turn.status === "pending"
        && (!missingDatasetReceipt || normalizedOptions.datasetId === null)
        && requestedProject === boundConversation.projectId
        && normalizedOptions.datasetId === boundConversationBinding.datasetId
        && existing.requestHash === conversationTurnRequestHash(userMessage, compatibleOptions);
      if ((input.conversationId && input.conversationId !== turn.conversationId) || (hash !== turn.requestHash && !canUpgradeLegacyHash)) {
        throw new ConversationTurnError("conflict", "That turn id is already bound to a different request.");
      }
      if (hash !== turn.requestHash && canUpgradeLegacyHash) {
        database.prepare("UPDATE conversation_turns SET request_hash = ?, request_options = ? WHERE id = ?")
          .run(hash, JSON.stringify(normalizedOptions), turn.id);
        const upgraded = getTurnRow(turn.id);
        if (!upgraded) throw new ConversationTurnError("integrity", "The upgraded turn could not be read.");
        turn = parseTurn(upgraded);
      }
      return { turn, conversationId: turn.conversationId, replayed: true };
    }

    let conversationId = input.conversationId;
    let conversation = conversationId ? getConversation(conversationId) : null;
    const now = new Date().toISOString();
    if (conversationId && !conversation) throw new ConversationTurnError("not-found", "Conversation not found.");
    if (!conversation) {
      if (input.projectId && !database.prepare("SELECT 1 FROM projects WHERE id = ?").get(input.projectId)) {
        throw new ConversationTurnError("conflict", "The selected project no longer exists. Nothing was sent; choose a current project and try again.");
      }
      conversationId = randomUUID();
      database.prepare(`
        INSERT INTO conversations (id, title, messages, project_id, dataset_id, pinned, created_at, updated_at)
        VALUES (?, ?, '[]', ?, ?, 0, ?, ?)
      `).run(conversationId, "New conversation", input.projectId ?? null, input.datasetId ?? null, now, now);
      conversation = getConversation(conversationId);
    }
    if (!conversationId || !conversation) throw new ConversationTurnError("integrity", "Could not create the local conversation.");
    const currentBinding = conversationContextBinding(conversation);

    if (input.expectedConversationBinding) {
      const binding = input.expectedConversationBinding;
      if (binding.projectId !== currentBinding.projectId
        || binding.datasetId !== currentBinding.datasetId
        || binding.datasetSha256 !== currentBinding.datasetSha256
        || binding.contextMessageCount !== currentBinding.contextMessageCount) {
        throw new ConversationTurnError("conflict", "This chat changed in another local window. Nothing was sent; reload the conversation before trying again.");
      }
    }

    if (input.options.recoveryBinding) {
      const binding = input.options.recoveryBinding;
      const sourceTurn = getConversationTurn(binding.sourceTurnId);
      if (!sourceTurn || sourceTurn.conversationId !== conversationId
        || (sourceTurn.status !== "failed" && sourceTurn.status !== "cancelled")
        || !Object.prototype.hasOwnProperty.call(sourceTurn.options, "projectId")
        || (sourceTurn.options.projectId ?? null) !== binding.projectId
        || (sourceTurn.options.datasetId ?? null) !== binding.datasetId
        || (sourceTurn.options.datasetSha256 ?? null) !== binding.datasetSha256
        || sourceTurn.contextMessageCount !== binding.contextMessageCount
        || binding.conversationId !== conversationId
        || binding.projectId !== currentBinding.projectId
        || binding.datasetId !== currentBinding.datasetId
        || binding.datasetSha256 !== currentBinding.datasetSha256
        || binding.contextMessageCount !== currentBinding.contextMessageCount) {
        throw new ConversationTurnError("conflict", "This chat or its local data changed after recovery. Nothing was sent; review the current conversation and try again.");
      }
    }

    const pending = database.prepare("SELECT id FROM conversation_turns WHERE conversation_id = ? AND status = 'pending' LIMIT 1").get(conversationId) as { id: string } | undefined;
    if (pending) throw new ConversationTurnError("turn-in-progress", "This conversation already has a turn in progress.");

    const sequenceRow = database.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM conversation_turns WHERE conversation_id = ?").get(conversationId) as { sequence: number };
    const options = normalizeOptions(input.options, currentBinding.datasetId, currentBinding.projectId);
    const hash = conversationTurnRequestHash(userMessage, options);
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
  // Candidate inspection hashes only public source files and must happen
  // before the SQLite write lock is acquired. The resulting identity is then
  // frozen for this one generation lifecycle.
  const candidate = getRuntimeResponseFeedbackCandidate();
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
    return {
      kind: "claimed",
      turn: claimed,
      messages: buildBoundedPromptMessages(conversation.messages, claimed.userMessage),
      candidateBuildId: candidate.state === "known" ? candidate.candidateBuildId : null,
    };
  });
}

function sameMessage(left: ChatMessage | null, right: ChatMessage) {
  return left ? JSON.stringify(withoutTurnMetadata(left)) === JSON.stringify(withoutTurnMetadata(right)) : false;
}

export function completeConversationTurn(
  turnId: string,
  assistantMessage: ChatMessage,
  candidateBuildId: string | null = null,
): ConversationTurn {
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
    recordCompletedResponseFeedback(database, turnId, candidateBuildId, now);
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
