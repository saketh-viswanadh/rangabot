export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
export const DEFAULT_CHAT_MODEL = "llama3.2:3b";
export const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text";
export const DEFAULT_KNOWLEDGE_BUDGET_BYTES = 4 * 1024 ** 3;

function isLoopbackHostname(hostname: string) {
  if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") return true;
  const octets = hostname.split(".").map(Number);
  return octets.length === 4
    && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    && octets[0] === 127;
}

export function getLocalOllamaBaseUrl(value = process.env.OLLAMA_BASE_URL) {
  const configured = value?.trim() || DEFAULT_OLLAMA_BASE_URL;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("OLLAMA_BASE_URL must be a valid loopback HTTP URL.");
  }
  if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname) || url.username || url.password || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("Rangabot only permits a loopback OLLAMA_BASE_URL (127.0.0.1, ::1, or localhost over HTTP).");
  }
  return url.origin;
}

export function getConfiguredChatModel(value = process.env.OLLAMA_MODEL) {
  return value?.trim() || DEFAULT_CHAT_MODEL;
}

export function getConfiguredEmbeddingModel(value = process.env.OLLAMA_EMBED_MODEL) {
  return value?.trim() || DEFAULT_EMBEDDING_MODEL;
}

export function getKnowledgeBudgetBytes(value = process.env.KNOWLEDGE_BUDGET_BYTES) {
  const parsed = value?.trim() ? Number(value) : DEFAULT_KNOWLEDGE_BUDGET_BYTES;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("KNOWLEDGE_BUDGET_BYTES must be a positive integer.");
  return parsed;
}
