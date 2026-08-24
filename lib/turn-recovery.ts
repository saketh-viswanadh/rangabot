import type { ChatMessage } from "./providers/types.ts";

export const TURN_RECOVERY_VERSION = "turn-recovery-v1" as const;

export type TurnRecoveryAction = "restore-request" | "open-models";

export type TurnRecoveryPlan = {
  title: string;
  guidance: string;
  primaryAction: TurnRecoveryAction;
  secondaryAction?: TurnRecoveryAction;
};

export type TurnRecoveryCodeContext = {
  repositoryId: string;
  repositoryName: string;
  path: string;
  line: number;
  startLine: number;
  endLine: number;
  characterCount: number;
  previewSha256: string;
};

export type TurnRecoveryDraft = {
  version: typeof TURN_RECOVERY_VERSION;
  sourceTurnId: string;
  requestHash: string;
  failureCode: string;
  message: Pick<ChatMessage, "role" | "content" | "replyTo" | "codeContext">;
  mode: "local" | "smart" | "teach" | "codex";
  binding: { conversationId: string; projectId: string | null; datasetId: string | null; datasetSha256: string | null; contextMessageCount: number };
  codeContext?: TurnRecoveryCodeContext;
};

/** Keep hidden binding state only when the start outcome itself is ambiguous. */
export function shouldRetainRecoveryBindingAfterStartFailure(failureCode?: string) {
  return failureCode === undefined || failureCode === "internal";
}

const modelAttentionCodes = new Set(["model-missing", "model-unqualified", "provider-unavailable", "unavailable"]);
const waitCodes = new Set(["busy", "interrupted"]);
const smallerRequestCodes = new Set(["timeout", "resource-limit"]);
const permissionCodes = new Set(["permission-required", "capability-unavailable"]);

/**
 * Produces a local, deterministic recovery suggestion. It never retries or
 * opens a resource; the UI must wait for an explicit user action.
 */
export function turnRecoveryPlan(status: "cancelled" | "failed", failureCode?: string): TurnRecoveryPlan {
  const code = status === "cancelled" ? "cancelled" : failureCode ?? "internal";
  if (code === "cancelled") return {
    title: "Stopped safely",
    guidance: "No complete answer was saved. Restore the original request when you want to continue.",
    primaryAction: "restore-request",
  };
  if (modelAttentionCodes.has(code)) return {
    title: "Local model needs attention",
    guidance: "No complete answer was saved. Check the local model, then restore the same request when it is ready.",
    primaryAction: "open-models",
    secondaryAction: "restore-request",
  };
  if (waitCodes.has(code)) return {
    title: "Your request is preserved",
    guidance: "The local engine did not finish. Wait for other local work to settle, then restore this request and review it before sending.",
    primaryAction: "restore-request",
  };
  if (smallerRequestCodes.has(code)) return {
    title: "Try a smaller next step",
    guidance: "The local run exceeded a time or output boundary. Restore the request, then shorten it or split it into smaller parts before sending.",
    primaryAction: "restore-request",
  };
  if (permissionCodes.has(code)) return {
    title: "Local access needs review",
    guidance: "The requested local capability was not available. Restore the request only after reviewing or reapproving the required local resource.",
    primaryAction: "restore-request",
  };
  return {
    title: "Recover this request",
    guidance: "No complete answer was saved. Restore the saved request and revalidate its file and code bindings. If the request selects data analysis, current learned dataset context may be applied at Send time; it is not frozen by recovery.",
    primaryAction: "restore-request",
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(value).every((key) => allowed.includes(key)) && allowed.every((key) => key in value);
}

function nullableId(value: unknown) {
  return value === null || typeof value === "string" && value.length > 0 && value.length <= 120;
}

function validUuid(value: unknown) {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validReply(value: unknown): value is NonNullable<ChatMessage["replyTo"]> {
  if (!record(value) || !exactKeys(value, ["role", "excerpt"])) return false;
  return (value.role === "user" || value.role === "assistant")
    && typeof value.excerpt === "string" && value.excerpt.length <= 500;
}

function validDisplayCode(value: unknown): value is NonNullable<ChatMessage["codeContext"]> {
  if (!record(value) || !exactKeys(value, ["repository", "path", "startLine", "endLine"])) return false;
  return typeof value.repository === "string" && value.repository.length > 0 && value.repository.length <= 240
    && typeof value.path === "string" && value.path.length > 0 && value.path.length <= 1024
    && Number.isSafeInteger(value.startLine) && (value.startLine as number) >= 1
    && Number.isSafeInteger(value.endLine) && (value.endLine as number) >= (value.startLine as number);
}

function validRecoveryCode(value: unknown): value is TurnRecoveryCodeContext {
  if (!record(value) || !exactKeys(value, ["repositoryId", "repositoryName", "path", "line", "startLine", "endLine", "characterCount", "previewSha256"])) return false;
  return typeof value.repositoryId === "string" && value.repositoryId.length > 0 && value.repositoryId.length <= 120
    && typeof value.repositoryName === "string" && value.repositoryName.length > 0 && value.repositoryName.length <= 240
    && typeof value.path === "string" && value.path.length > 0 && value.path.length <= 1024
    && Number.isSafeInteger(value.line) && (value.line as number) >= 1
    && Number.isSafeInteger(value.startLine) && (value.startLine as number) >= 1
    && Number.isSafeInteger(value.endLine) && (value.endLine as number) >= (value.startLine as number)
    && (value.line as number) >= (value.startLine as number) && (value.line as number) <= (value.endLine as number)
    && Number.isSafeInteger(value.characterCount) && (value.characterCount as number) >= 0 && (value.characterCount as number) <= 1_000_000
    && typeof value.previewSha256 === "string" && /^[a-f0-9]{64}$/.test(value.previewSha256);
}

function recoveryRequestPayload(draft: TurnRecoveryDraft) {
  const message: TurnRecoveryDraft["message"] = {
    role: "user",
    content: draft.message.content,
    ...(draft.message.replyTo ? { replyTo: { role: draft.message.replyTo.role, excerpt: draft.message.replyTo.excerpt } } : {}),
    ...(draft.message.codeContext ? { codeContext: {
      repository: draft.message.codeContext.repository,
      path: draft.message.codeContext.path,
      startLine: draft.message.codeContext.startLine,
      endLine: draft.message.codeContext.endLine,
    } } : {}),
  };
  const options = {
    mode: draft.mode,
    ...(draft.codeContext ? { codeContext: {
      repositoryId: draft.codeContext.repositoryId,
      path: draft.codeContext.path,
      line: draft.codeContext.line,
      previewSha256: draft.codeContext.previewSha256,
    } } : {}),
    datasetId: draft.binding.datasetId,
    datasetSha256: draft.binding.datasetSha256,
    projectId: draft.binding.projectId,
  };
  return JSON.stringify({ message, options });
}

/** Recomputes the server's canonical request receipt before any composer state changes. */
export async function verifyTurnRecoveryDraftHash(draft: TurnRecoveryDraft) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(recoveryRequestPayload(draft)));
  const actual = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return actual === draft.requestHash;
}

/** Strictly validates the private recovery response before it can change UI state. */
export function parseTurnRecoveryDraft(value: unknown): TurnRecoveryDraft | null {
  if (!record(value) || !exactKeys(value, ["version", "sourceTurnId", "requestHash", "failureCode", "message", "mode", "binding"])) {
    if (!record(value) || !exactKeys(value, ["version", "sourceTurnId", "requestHash", "failureCode", "message", "mode", "binding", "codeContext"])) return null;
  }
  if (value.version !== TURN_RECOVERY_VERSION
    || !validUuid(value.sourceTurnId)
    || typeof value.requestHash !== "string" || !/^[0-9a-f]{64}$/.test(value.requestHash)
    || typeof value.failureCode !== "string" || !value.failureCode || value.failureCode.length > 80
    || (value.mode !== "local" && value.mode !== "smart" && value.mode !== "teach" && value.mode !== "codex")
    || !record(value.message) || !exactKeys(value.message, value.message.replyTo === undefined && value.message.codeContext === undefined
      ? ["role", "content"]
      : value.message.replyTo === undefined ? ["role", "content", "codeContext"]
        : value.message.codeContext === undefined ? ["role", "content", "replyTo"] : ["role", "content", "replyTo", "codeContext"])
    || value.message.role !== "user" || typeof value.message.content !== "string" || !value.message.content.trim() || value.message.content.length > 50_000
    || value.message.replyTo !== undefined && !validReply(value.message.replyTo)
    || value.message.codeContext !== undefined && !validDisplayCode(value.message.codeContext)
    || !record(value.binding) || !exactKeys(value.binding, ["conversationId", "projectId", "datasetId", "datasetSha256", "contextMessageCount"])
    || typeof value.binding.conversationId !== "string" || !value.binding.conversationId || value.binding.conversationId.length > 120
    || !nullableId(value.binding.projectId) || !nullableId(value.binding.datasetId)
    || (value.binding.datasetId === null ? value.binding.datasetSha256 !== null : typeof value.binding.datasetSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.binding.datasetSha256))
    || !Number.isSafeInteger(value.binding.contextMessageCount) || (value.binding.contextMessageCount as number) < 0
    || value.codeContext !== undefined && !validRecoveryCode(value.codeContext)
    || Boolean(value.message.codeContext) !== Boolean(value.codeContext)
    || value.codeContext !== undefined && value.message.codeContext !== undefined
      && (value.message.codeContext.repository !== value.codeContext.repositoryName
        || value.message.codeContext.path !== value.codeContext.path
        || value.message.codeContext.startLine !== value.codeContext.startLine
        || value.message.codeContext.endLine !== value.codeContext.endLine)) return null;
  return value as TurnRecoveryDraft;
}
