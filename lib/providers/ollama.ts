import { ProviderError, type ChatMessage, type GenerationOptions, type LocalChatProvider, type ProviderStatus } from "./types.ts";
import { getConfiguredChatModel, getConfiguredContextTokens, getLocalOllamaBaseUrl } from "../local-runtime-config.ts";

const configuredModel = getConfiguredChatModel();

function generationOptions(options: GenerationOptions | undefined, defaultNumPredict: number) {
  return {
    num_predict: options?.numPredict ?? defaultNumPredict,
    num_ctx: options?.numContext ?? getConfiguredContextTokens(),
  };
}

export function providerErrorFrom(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof DOMException && error.name === "TimeoutError") return new ProviderError("timeout", "The local model timed out.", { cause: error });
  if (error instanceof DOMException && error.name === "AbortError") return new ProviderError("cancelled", "Generation was stopped.", { cause: error });
  return new ProviderError("unavailable", error instanceof Error ? error.message : "Could not connect to the local model.", { cause: error });
}

async function ollamaFetch(path: string, init?: RequestInit, timeoutMs = 120_000) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  try {
    return await fetch(`${getLocalOllamaBaseUrl()}${path}`, {
      ...init,
      signal,
      headers: { "Content-Type": "application/json", ...init?.headers },
      cache: "no-store",
    });
  } catch (error) {
    throw providerErrorFrom(error);
  }
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

export async function completeJsonWithOllama(messages: ChatMessage[], options?: GenerationOptions): Promise<string> {
  const response = await ollamaFetch("/api/chat", {
    method: "POST",
    signal: options?.signal,
    body: JSON.stringify({
      model: options?.modelId ?? configuredModel,
      messages: messages.map(({ role, content }) => ({ role, content })),
      format: options?.jsonSchema ?? "json",
      stream: false,
      options: generationOptions(options, 1800),
    }),
  }, options?.timeoutMs ?? 120_000);
  if (!response.ok) throw new ProviderError(response.status === 404 ? "model-missing" : "http", `Ollama request failed (${response.status}): ${await response.text()}`);
  const data = (await response.json()) as { message?: { content?: string } };
  const content = data.message?.content?.trim();
  if (!content) throw new ProviderError("empty-output", "Ollama returned an empty document draft.");
  return content;
}

export async function completeTextWithOllama(messages: ChatMessage[], options?: GenerationOptions): Promise<string> {
  const response = await ollamaFetch("/api/chat", {
    method: "POST",
    signal: options?.signal,
    body: JSON.stringify({
      model: options?.modelId ?? configuredModel,
      messages: messages.map(({ role, content }) => ({ role, content })),
      stream: false,
      options: generationOptions(options, 1000),
    }),
  }, options?.timeoutMs ?? 120_000);
  if (!response.ok) throw new ProviderError(response.status === 404 ? "model-missing" : "http", `Ollama request failed (${response.status}): ${await response.text()}`);
  const data = (await response.json()) as { message?: { content?: string } };
  const content = data.message?.content?.trim();
  if (!content) throw new ProviderError("empty-output", "Ollama returned an empty response.");
  return content;
}

export async function streamChatWithOllama(messages: ChatMessage[], options?: GenerationOptions): Promise<ReadableStream<Uint8Array>> {
  const response = await ollamaFetch("/api/chat", {
    method: "POST",
    signal: options?.signal,
    body: JSON.stringify({
      model: options?.modelId ?? configuredModel,
      messages: messages.map(({ role, content }) => ({ role, content })),
      stream: true,
      options: generationOptions(options, 1000),
    }),
  }, options?.timeoutMs ?? 120_000);

  if (!response.ok) {
    const detail = await response.text();
    throw new ProviderError(response.status === 404 ? "model-missing" : "http", `Ollama request failed (${response.status}): ${detail}`);
  }

  if (!response.body) throw new ProviderError("empty-output", "Ollama returned an empty response stream");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let emitted = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          if (buffer.trim()) emitted = processLine(buffer, controller, encoder) || emitted;
          if (emitted) controller.close();
          else controller.error(new ProviderError("empty-output", "Ollama returned an empty response stream."));
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) emitted = processLine(line, controller, encoder) || emitted;
      } catch (error) {
        controller.error(providerErrorFrom(error));
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
  if (!line.trim()) return false;
  let chunk: OllamaStreamChunk;
  try { chunk = JSON.parse(line) as OllamaStreamChunk; }
  catch (error) { throw new ProviderError("invalid-stream", "Ollama returned a malformed stream chunk.", { cause: error }); }
  if (chunk.error) throw new ProviderError("http", chunk.error);
  if (!chunk.message?.content) return false;
  controller.enqueue(encoder.encode(chunk.message.content));
  return true;
}

export const ollamaProvider: LocalChatProvider = {
  id: "ollama",
  status: getOllamaStatus,
  completeJson: completeJsonWithOllama,
  completeText: completeTextWithOllama,
  stream: streamChatWithOllama,
};
