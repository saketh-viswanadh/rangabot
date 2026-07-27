import type { ChatMessage, ProviderStatus } from "./types";

const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
const configuredModel = process.env.OLLAMA_MODEL ?? "gpt-oss:20b";

async function ollamaFetch(path: string, init?: RequestInit, timeoutMs = 120_000) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "Content-Type": "application/json", ...init?.headers },
    cache: "no-store",
  });
}

export async function getOllamaStatus(): Promise<ProviderStatus> {
  try {
    const response = await ollamaFetch("/api/tags", undefined, 2_500);
    if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
    const data = (await response.json()) as { models?: Array<{ name: string }> };
    const models = data.models?.map((model) => model.name) ?? [];
    return {
      available: true,
      provider: "ollama",
      configuredModel,
      modelInstalled: models.some((name) => name === configuredModel || name.startsWith(`${configuredModel}:`)),
      models,
    };
  } catch (error) {
    return {
      available: false,
      provider: "ollama",
      configuredModel,
      modelInstalled: false,
      models: [],
      error: error instanceof Error ? error.message : "Could not connect to Ollama",
    };
  }
}

export async function chatWithOllama(messages: ChatMessage[]): Promise<string> {
  const response = await ollamaFetch("/api/chat", {
    method: "POST",
    body: JSON.stringify({ model: configuredModel, messages, stream: false }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Ollama request failed (${response.status}): ${detail}`);
  }

  const data = (await response.json()) as { message?: { content?: string } };
  if (!data.message?.content) throw new Error("Ollama returned an empty response");
  return data.message.content;
}
