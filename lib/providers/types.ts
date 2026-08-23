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
