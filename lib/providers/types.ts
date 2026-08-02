export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  artifactIntent?: "word";
  retrievalMode?: "hybrid" | "keyword-only";
  memoryUse?: "context" | "direct";
  memoryTitles?: string[];
  wordArtifact?: {
    id: string;
    title: string;
    filename: string;
    previewPages: number;
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

export type ProviderFailureCode = "unavailable" | "model-missing" | "timeout" | "cancelled" | "http" | "empty-output" | "invalid-stream";

export class ProviderError extends Error {
  readonly code: ProviderFailureCode;
  constructor(code: ProviderFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "ProviderError";
  }
}

export interface GenerationOptions {
  numPredict?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LocalChatProvider {
  readonly id: "ollama";
  status(): Promise<ProviderStatus>;
  completeJson(messages: ChatMessage[], options?: GenerationOptions): Promise<string>;
  completeText(messages: ChatMessage[], options?: GenerationOptions): Promise<string>;
  stream(messages: ChatMessage[], options?: GenerationOptions): Promise<ReadableStream<Uint8Array>>;
}
