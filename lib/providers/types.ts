export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  artifactIntent?: "word";
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
