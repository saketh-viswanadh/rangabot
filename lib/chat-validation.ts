import type { ChatMessage } from "./providers/types";
import { expertPackWarningCodes, type ExpertPackWarningCode } from "./expert-packs.ts";

export const MAX_CHAT_MESSAGES = 200;
export const MAX_CHAT_MESSAGE_CHARS = 50_000;
export const MAX_CHAT_TOTAL_CHARS = 1_000_000;
const messageKeys = new Set(["role", "content", "artifactIntent", "wordArtifact", "analysisTrace", "codeContext", "replyTo", "retrievalMode", "memoryUse", "memoryTitles", "answerDisposition", "packWarnings", "knowledgeUsed", "finishVerification", "capabilityReceipt"]);
const analysisTraceKeys = new Set(["engine", "dataset", "query", "returnedRows", "truncated", "durationMs", "inputSha256", "querySha256", "packId", "packVersion", "modelMode", "modelId"]);
const finishVerificationKeys = new Set(["version", "status", "checks", "issueCount", "manualReview"]);
const finishVerificationChecks = new Set(["requirements", "arithmetic", "code-structure", "preservation", "completion"]);
const finishVerificationCheckOrder = ["completion", "requirements", "arithmetic", "code-structure", "preservation"];
const capabilityReceiptKeys = new Set(["version", "status", "route", "contexts", "attemptedContexts", "reasons"]);
const capabilityRoutes = new Set(["safe-continuation", "deterministic-answer", "direct-memory", "analytics", "word-document", "knowledge-vault", "repository-context", "conversation", "clarification", "unavailable"]);
const capabilityContexts = new Set(["dataset", "repository", "knowledge-vault", "approved-memory"]);
const capabilityReasons = new Set(["external-action-unavailable", "deterministic-contract", "explicit-memory-recall", "attached-data-analysis", "missing-required-dataset", "explicit-word-artifact", "explicit-vault-request", "teacher-mode", "smart-vault-match", "attached-repository-context", "ordinary-conversation", "multiple-material-capabilities", "cloud-handoff-disabled"]);

function sameValues(values: unknown[], expected: string[]) {
  return values.length === expected.length && expected.every((value) => values.includes(value));
}

function sameSequence(values: unknown[], expected: string[]) {
  return values.length === expected.length && values.every((value, index) => value === expected[index]);
}

function oneSequence(values: unknown[], expected: string[][]) {
  return expected.some((sequence) => sameSequence(values, sequence));
}

function validCapabilitySemantics(receipt: Record<string, unknown>) {
  const route = String(receipt.route);
  const status = String(receipt.status);
  const contexts = receipt.contexts as unknown[];
  const attemptedContexts = (receipt.attemptedContexts ?? receipt.contexts) as unknown[];
  const hasExplicitAttempts = Object.prototype.hasOwnProperty.call(receipt, "attemptedContexts");
  const reasons = receipt.reasons as unknown[];
  if (!contexts.every((context) => attemptedContexts.includes(context))) return false;
  if (route === "safe-continuation") return status === "selected" && sameValues(contexts, []) && sameValues(attemptedContexts, []) && sameValues(reasons, ["external-action-unavailable"]);
  if (route === "deterministic-answer") return status === "selected" && sameValues(contexts, []) && sameValues(attemptedContexts, []) && sameValues(reasons, ["deterministic-contract"]);
  if (route === "direct-memory") return status === "selected"
    && (sameValues(contexts, []) || sameValues(contexts, ["approved-memory"]))
    && (hasExplicitAttempts ? sameValues(attemptedContexts, ["approved-memory"]) : sameValues(contexts, ["approved-memory"]))
    && sameValues(reasons, ["explicit-memory-recall"]);
  if (route === "analytics") return status === "selected"
    && (sameValues(contexts, []) || sameValues(contexts, ["dataset"]))
    && (hasExplicitAttempts ? sameValues(attemptedContexts, ["dataset"]) : sameValues(contexts, ["dataset"]))
    && sameValues(reasons, ["attached-data-analysis"]);
  if (route === "word-document") {
    const hasRepositoryReason = reasons.includes("attached-repository-context");
    if (status !== "selected" || !(sameValues(reasons, ["explicit-word-artifact"])
      || sameValues(reasons, ["explicit-word-artifact", "attached-repository-context"]))) return false;
    if (!hasRepositoryReason) return sameSequence(contexts, []) && sameSequence(attemptedContexts, []);
    return oneSequence(contexts, [[], ["repository"]])
      && (hasExplicitAttempts ? sameSequence(attemptedContexts, ["repository"]) : sameSequence(contexts, ["repository"]));
  }
  if (route === "knowledge-vault") {
    const hasRepositoryReason = reasons.includes("attached-repository-context");
    if (status !== "selected"
      || !contexts.every((context) => ["knowledge-vault", "repository", "approved-memory"].includes(String(context)))
      || !attemptedContexts.every((context) => ["knowledge-vault", "repository", "approved-memory"].includes(String(context)))
      || reasons.filter((reason) => ["explicit-vault-request", "teacher-mode", "smart-vault-match"].includes(String(reason))).length !== 1
      || !reasons.every((reason) => ["explicit-vault-request", "teacher-mode", "smart-vault-match", "attached-repository-context"].includes(String(reason)))) return false;
    const attempts = hasRepositoryReason
      ? [["repository"], ["repository", "knowledge-vault"], ["repository", "knowledge-vault", "approved-memory"]]
      : [["knowledge-vault"], ["knowledge-vault", "approved-memory"]];
    const completed = hasRepositoryReason
      ? [[], ["repository"], ["repository", "knowledge-vault"], ["repository", "knowledge-vault", "approved-memory"]]
      : [[], ["knowledge-vault"], ["knowledge-vault", "approved-memory"]];
    if (!hasExplicitAttempts) return hasRepositoryReason
      ? oneSequence(contexts, [["repository", "knowledge-vault"], ["repository", "knowledge-vault", "approved-memory"]])
      : oneSequence(contexts, [["knowledge-vault"], ["knowledge-vault", "approved-memory"]]);
    if (!oneSequence(attemptedContexts, attempts)) return false;
    if (!oneSequence(contexts, completed)) return false;
    if (hasRepositoryReason) {
      if (sameSequence(attemptedContexts, ["repository"])) return sameSequence(contexts, []);
      if (sameSequence(attemptedContexts, ["repository", "knowledge-vault"])) return oneSequence(contexts, [["repository"], ["repository", "knowledge-vault"]]);
      return oneSequence(contexts, [["repository", "knowledge-vault"], ["repository", "knowledge-vault", "approved-memory"]]);
    }
    if (sameSequence(attemptedContexts, ["knowledge-vault"])) return oneSequence(contexts, [[], ["knowledge-vault"]]);
    return oneSequence(contexts, [["knowledge-vault"], ["knowledge-vault", "approved-memory"]]);
  }
  if (route === "repository-context") {
    if (status !== "selected" || !sameValues(reasons, ["attached-repository-context"])) return false;
    if (!hasExplicitAttempts) return oneSequence(contexts, [["repository"], ["repository", "approved-memory"]]);
    if (!oneSequence(attemptedContexts, [["repository"], ["repository", "approved-memory"]])) return false;
    if (sameSequence(attemptedContexts, ["repository"])) return oneSequence(contexts, [[], ["repository"]]);
    return oneSequence(contexts, [["repository"], ["repository", "approved-memory"]]);
  }
  if (route === "conversation") return status === "selected"
    && contexts.every((context) => context === "approved-memory")
    && attemptedContexts.every((context) => context === "approved-memory")
    && sameValues(reasons, ["ordinary-conversation"]);
  if (route === "clarification") return status === "clarify" && sameValues(contexts, []) && sameValues(attemptedContexts, [])
    && (sameValues(reasons, ["multiple-material-capabilities"]) || sameValues(reasons, ["missing-required-dataset"]));
  return route === "unavailable" && status === "unavailable" && sameValues(contexts, []) && sameValues(attemptedContexts, []) && sameValues(reasons, ["cloud-handoff-disabled"]);
}

export function isValidCapabilityReceipt(value: unknown): value is NonNullable<ChatMessage["capabilityReceipt"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  const status = String(receipt.status);
  const route = String(receipt.route);
  const attemptedContexts = receipt.attemptedContexts;
  return (Object.keys(receipt).length === 5 || Object.keys(receipt).length === 6)
    && Object.keys(receipt).every((key) => capabilityReceiptKeys.has(key))
    && receipt.version === "capability-route-v1"
    && ["selected", "clarify", "unavailable"].includes(status)
    && capabilityRoutes.has(route)
    && (status === "selected" ? route !== "clarification" && route !== "unavailable" : status === "clarify" ? route === "clarification" : route === "unavailable")
    && Array.isArray(receipt.contexts) && receipt.contexts.length <= 4
    && new Set(receipt.contexts).size === receipt.contexts.length
    && receipt.contexts.every((context) => capabilityContexts.has(String(context)))
    && (attemptedContexts === undefined || Array.isArray(attemptedContexts) && attemptedContexts.length <= 4
      && new Set(attemptedContexts).size === attemptedContexts.length
      && attemptedContexts.every((context) => capabilityContexts.has(String(context))))
    && Array.isArray(receipt.reasons) && receipt.reasons.length >= 1 && receipt.reasons.length <= 3
    && new Set(receipt.reasons).size === receipt.reasons.length
    && receipt.reasons.every((reason) => capabilityReasons.has(String(reason)))
    && validCapabilitySemantics(receipt);
}

export function parseCapabilityReceiptHeader(value: string | null) {
  if (!value || value.length > 2_000) return null;
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(value));
    return isValidCapabilityReceipt(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isValidFinishVerification(value: unknown): value is NonNullable<ChatMessage["finishVerification"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  const checks = receipt.checks;
  return (Object.keys(receipt).length === 4 || Object.keys(receipt).length === 5)
    && Object.keys(receipt).every((key) => finishVerificationKeys.has(key))
    && receipt.version === "finish-v1"
    && ["passed", "repaired", "warning"].includes(String(receipt.status))
    && Array.isArray(checks) && checks.length >= 1 && checks.length <= 5
    && new Set(checks).size === checks.length
    && checks.every((check) => finishVerificationChecks.has(String(check)))
    && checks.every((check, index) => String(check) === finishVerificationCheckOrder.filter((candidate) => checks.includes(candidate))[index])
    && checks[0] === "completion"
    && typeof receipt.issueCount === "number" && Number.isInteger(receipt.issueCount)
    && receipt.issueCount >= 0 && receipt.issueCount <= 20
    && (receipt.status === "warning" ? receipt.issueCount > 0 : receipt.issueCount === 0)
    && (receipt.manualReview === undefined
      || receipt.manualReview === "ambiguous-sentence-boundary"
        && receipt.status === "warning"
        && checks.includes("requirements"));
}

export function parseFinishVerificationHeader(value: string | null) {
  if (!value || value.length > 1_000) return null;
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(value));
    return isValidFinishVerification(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

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
  return parsePackWarningCodesHeader(value)?.length ? "verified-fallback" : null;
}

export function parsePackWarningCodesHeader(value: string | null): NonNullable<ChatMessage["packWarnings"]> | null {
  if (!value || value.length > 256) return null;
  const codes = value.split(",").map((code) => code.trim());
  if (codes.length === 0 || codes.length > 2 || new Set(codes).size !== codes.length
    || !codes.every((code) => expertPackWarningCodes.includes(code as ExpertPackWarningCode))) return null;
  return codes as NonNullable<ChatMessage["packWarnings"]>;
}

function validOptionalMetadata(message: Record<string, unknown>) {
  if (!Object.keys(message).every((key) => messageKeys.has(key))) return false;
  if (message.knowledgeUsed !== undefined && (message.knowledgeUsed !== true || message.role !== "assistant")) return false;
  if (message.finishVerification !== undefined && (message.role !== "assistant" || !isValidFinishVerification(message.finishVerification))) return false;
  if (message.capabilityReceipt !== undefined && (message.role !== "assistant" || !isValidCapabilityReceipt(message.capabilityReceipt))) return false;
  if (message.artifactIntent !== undefined && message.artifactIntent !== "word") return false;
  if (message.retrievalMode !== undefined && !["hybrid", "keyword-only"].includes(String(message.retrievalMode))) return false;
  if (message.memoryUse !== undefined && !["context", "direct"].includes(String(message.memoryUse))) return false;
  if (message.answerDisposition !== undefined) {
    if (message.answerDisposition !== "verified-fallback" || message.role !== "assistant"
      || !isValidAnalysisTrace(message.analysisTrace)
      || !message.analysisTrace.packId) return false;
  }
  if (message.packWarnings !== undefined) {
    if (message.role !== "assistant" || message.answerDisposition !== "verified-fallback"
      || !Array.isArray(message.packWarnings) || message.packWarnings.length < 1 || message.packWarnings.length > 2
      || new Set(message.packWarnings).size !== message.packWarnings.length
      || !message.packWarnings.every((code) => expertPackWarningCodes.includes(code as ExpertPackWarningCode))) return false;
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
