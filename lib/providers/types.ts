export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ProviderStatus {
  available: boolean;
  provider: "ollama";
  configuredModel: string;
  modelInstalled: boolean;
  models: string[];
  error?: string;
}
