export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  role: ChatRole;
  content: string;
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
