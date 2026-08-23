export type ChatRole = "user" | "assistant" | "system";
export type ConversationTurnStatus = "pending" | "completed" | "cancelled" | "failed";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Internal persistence receipt. Client-authored chat payloads may not set it. */
  turn?: {
    id: string;
    status: ConversationTurnStatus;
    failureCode?: string;
  };
  knowledgeUsed?: boolean;
  artifactIntent?: "word";
  retrievalMode?: "hybrid" | "keyword-only";
  memoryUse?: "context" | "direct";
  memoryTitles?: string[];
  answerDisposition?: "verified-fallback";
  finishVerification?: {
    version: "finish-v1";
    status: "passed" | "repaired" | "warning";
    checks: Array<"requirements" | "arithmetic" | "code-structure" | "preservation" | "completion">;
    issueCount: number;
    manualReview?: "ambiguous-sentence-boundary";
  };
  capabilityReceipt?: {
    version: "capability-route-v1";
    status: "selected" | "clarify" | "unavailable";
    route: "safe-continuation" | "deterministic-answer" | "direct-memory" | "analytics" | "word-document" | "knowledge-vault" | "repository-context" | "conversation" | "clarification" | "unavailable";
    contexts: Array<"dataset" | "repository" | "knowledge-vault" | "approved-memory">;
    /** Resources supplied to a selected local capability even if it failed before completion. */
    attemptedContexts?: Array<"dataset" | "repository" | "knowledge-vault" | "approved-memory">;
    reasons: Array<"external-action-unavailable" | "deterministic-contract" | "explicit-memory-recall" | "attached-data-analysis" | "missing-required-dataset" | "explicit-word-artifact" | "explicit-vault-request" | "teacher-mode" | "smart-vault-match" | "attached-repository-context" | "ordinary-conversation" | "multiple-material-capabilities" | "cloud-handoff-disabled">;
  };
  /** Exact, allowlisted expert-pack warning provenance for faithful replay. */
  packWarnings?: Array<"model-narration-unavailable" | "narration-grounding-rejected">;
  wordArtifact?: {
    id: string;
    title: string;
    filename: string;
    previewPages: number;
  };
  analysisTrace?: {
    engine: "duckdb";
    dataset: string;
    query: string;
    returnedRows: number;
    truncated: boolean;
    durationMs: number;
    inputSha256: string;
    querySha256: string;
    packId?: string;
    packVersion?: string;
    modelMode?: "automatic" | "general" | "custom";
    modelId?: string;
  };
  codeContext?: {
    repository: string;
    path: string;
    startLine: number;
    endLine: number;
  };
  replyTo?: {
    role: "user" | "assistant";
    excerpt: string;
  };
}

export interface ProviderStatus {
  available: boolean;
  provider: "ollama";
  configuredModel: string;
  modelInstalled: boolean;
  models: string[];
  error?: string;
}

export type ProviderFailureCode = "unavailable" | "model-missing" | "busy" | "timeout" | "cancelled" | "http" | "empty-output" | "invalid-stream" | "resource-limit";

export class ProviderError extends Error {
  readonly code: ProviderFailureCode;
  constructor(code: ProviderFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "ProviderError";
  }
}

export interface GenerationOptions {
  modelId?: string;
  numPredict?: number;
  numContext?: number;
  temperature?: number;
  seed?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  jsonSchema?: Record<string, unknown>;
}

export interface LocalChatProvider {
  readonly id: "ollama";
  status(): Promise<ProviderStatus>;
  completeJson(messages: ChatMessage[], options?: GenerationOptions): Promise<string>;
  completeText(messages: ChatMessage[], options?: GenerationOptions): Promise<string>;
  stream(messages: ChatMessage[], options?: GenerationOptions): Promise<ReadableStream<Uint8Array>>;
}
