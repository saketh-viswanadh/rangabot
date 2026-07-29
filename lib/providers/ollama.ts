import type { ChatMessage, ProviderStatus } from "./types";
import { getConfiguredChatModel, getLocalOllamaBaseUrl } from "../local-runtime-config.ts";

const configuredModel = getConfiguredChatModel();

async function ollamaFetch(path: string, init?: RequestInit, timeoutMs = 120_000) {
  return fetch(`${getLocalOllamaBaseUrl()}${path}`, {
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

interface OllamaStreamChunk {
  message?: { content?: string };
  error?: string;
}

export async function completeJsonWithOllama(messages: ChatMessage[], options?: { numPredict?: number }): Promise<string> {
  const response = await ollamaFetch("/api/chat", {
    method: "POST",
    body: JSON.stringify({
      model: configuredModel,
      messages: messages.map(({ role, content }) => ({ role, content })),
      format: "json",
      stream: false,
      options: { num_predict: options?.numPredict ?? 1800 },
    }),
  });
  if (!response.ok) throw new Error(`Ollama request failed (${response.status}): ${await response.text()}`);
  const data = (await response.json()) as { message?: { content?: string } };
  const content = data.message?.content?.trim();
  if (!content) throw new Error("Ollama returned an empty document draft.");
  return content;
}

export async function completeTextWithOllama(messages: ChatMessage[], options?: { numPredict?: number; timeoutMs?: number }): Promise<string> {
  const response = await ollamaFetch("/api/chat", {
    method: "POST",
    body: JSON.stringify({
      model: configuredModel,
      messages: messages.map(({ role, content }) => ({ role, content })),
      stream: false,
      options: { num_predict: options?.numPredict ?? 1000 },
    }),
  }, options?.timeoutMs ?? 120_000);
  if (!response.ok) throw new Error(`Ollama request failed (${response.status}): ${await response.text()}`);
  const data = (await response.json()) as { message?: { content?: string } };
  const content = data.message?.content?.trim();
  if (!content) throw new Error("Ollama returned an empty response.");
  return content;
}

export async function streamChatWithOllama(messages: ChatMessage[]): Promise<ReadableStream<Uint8Array>> {
  const response = await ollamaFetch("/api/chat", {
    method: "POST",
    body: JSON.stringify({ model: configuredModel, messages: messages.map(({ role, content }) => ({ role, content })), stream: true }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Ollama request failed (${response.status}): ${detail}`);
  }

  if (!response.body) throw new Error("Ollama returned an empty response stream");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          if (buffer.trim()) processLine(buffer, controller, encoder);
          controller.close();
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) processLine(line, controller, encoder);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

function processLine(
  line: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
) {
  if (!line.trim()) return;
  const chunk = JSON.parse(line) as OllamaStreamChunk;
  if (chunk.error) throw new Error(chunk.error);
  if (chunk.message?.content) controller.enqueue(encoder.encode(chunk.message.content));
}
