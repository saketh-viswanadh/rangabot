import { ProviderError, type ChatMessage, type GenerationOptions, type LocalChatProvider, type ProviderStatus } from "./types.ts";
import { getLocalOllamaBaseUrl } from "../local-runtime-config.ts";
import { localModelGenerationGate } from "../model-generation-gate.ts";
import { verificationLocalModelDisabled } from "../desktop-external-filesystem-policy.ts";
import { selectedChatContextTokens, selectedChatModel } from "../model-manager.ts";


export const OLLAMA_RESPONSE_LIMITS = Object.freeze({
  bufferedBodyBytes: 2 * 1024 * 1024,
  errorBodyBytes: 64 * 1024,
  streamWireBytes: 8 * 1024 * 1024,
  streamOutputBytes: 1024 * 1024,
  streamOutputChars: 1024 * 1024,
  streamPartialLineBytes: 256 * 1024,
  streamPartialLineChars: 256 * 1024,
  streamReadChunks: 32_768,
  streamLines: 32_768,
});

const RESOURCE_LIMIT_MESSAGE = "The local model response exceeded Rangabot's safe output limit. Ask for a shorter answer or reduce the requested output size.";

function responseLimitError() {
  return new ProviderError("resource-limit", RESOURCE_LIMIT_MESSAGE);
}

async function readBoundedResponseText(response: Response, maxBytes: number) {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    const error = responseLimitError();
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }

  const bytes = new Uint8Array(maxBytes);
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (totalBytes + value.byteLength > maxBytes) {
      const error = responseLimitError();
      await reader.cancel(error).catch(() => undefined);
      throw error;
    }
    bytes.set(value, totalBytes);
    totalBytes += value.byteLength;
  }
  return new TextDecoder().decode(bytes.subarray(0, totalBytes));
}

async function readBoundedJson<T>(response: Response): Promise<T> {
  const text = await readBoundedResponseText(response, OLLAMA_RESPONSE_LIMITS.bufferedBodyBytes);
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new ProviderError("invalid-stream", "Ollama returned a malformed JSON response.", { cause: error });
  }
}

async function ollamaHttpError(response: Response) {
  const detail = (await readBoundedResponseText(response, OLLAMA_RESPONSE_LIMITS.errorBodyBytes)).trim().slice(0, 1_000);
  const suffix = detail ? `: ${detail}` : "";
  return new ProviderError(response.status === 404 ? "model-missing" : "http", `Ollama request failed (${response.status})${suffix}`);
}

function generationOptions(options: GenerationOptions | undefined, defaultNumPredict: number) {
  return {
    num_predict: options?.numPredict ?? defaultNumPredict,
    num_ctx: options?.numContext ?? selectedChatContextTokens(),
    ...(typeof options?.temperature === "number" && Number.isFinite(options.temperature) ? { temperature: options.temperature } : {}),
    ...(typeof options?.seed === "number" && Number.isSafeInteger(options.seed) ? { seed: options.seed } : {}),
  };
}

export function providerErrorFrom(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof DOMException && error.name === "TimeoutError") return new ProviderError("timeout", "The local model timed out.", { cause: error });
  if (error instanceof DOMException && error.name === "AbortError") return new ProviderError("cancelled", "Generation was stopped.", { cause: error });
  return new ProviderError("unavailable", error instanceof Error ? error.message : "Could not connect to the local model.", { cause: error });
}

async function ollamaFetch(path: string, init?: RequestInit, timeoutMs = 120_000) {
  if (verificationLocalModelDisabled()) {
    throw new ProviderError("unavailable", "Local-model access is disabled in this sealed verification build.");
  }
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
  const configuredModel = selectedChatModel();
  try {
    const response = await ollamaFetch("/api/tags", undefined, 2_500);
    if (!response.ok) throw await ollamaHttpError(response);
    const data = await readBoundedJson<{ models?: Array<{ name: string }> }>(response);
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

function resolvedGeneration(modelId: string | undefined, signal: AbortSignal | undefined, timeoutMs: number) {
  const deadline = AbortSignal.timeout(timeoutMs);
  return {
    modelId: modelId ?? selectedChatModel(),
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  };
}

export async function completeJsonWithOllama(messages: ChatMessage[], options?: GenerationOptions): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? 120_000;
  const generation = resolvedGeneration(options?.modelId, options?.signal, timeoutMs);
  const lease = await localModelGenerationGate.acquire(generation.modelId, generation.signal);
  try {
    const response = await ollamaFetch("/api/chat", {
      method: "POST",
      signal: generation.signal,
      body: JSON.stringify({
        model: generation.modelId,
        messages: messages.map(({ role, content }) => ({ role, content })),
        format: options?.jsonSchema ?? "json",
        stream: false,
        options: generationOptions(options, 1800),
      }),
    }, timeoutMs);
    if (!response.ok) throw await ollamaHttpError(response);
    const data = await readBoundedJson<{ message?: { content?: string } }>(response);
    const content = data.message?.content?.trim();
    if (!content) throw new ProviderError("empty-output", "Ollama returned an empty document draft.");
    return content;
  } finally {
    lease.release();
  }
}

export async function completeTextWithOllama(messages: ChatMessage[], options?: GenerationOptions): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? 120_000;
  const generation = resolvedGeneration(options?.modelId, options?.signal, timeoutMs);
  const lease = await localModelGenerationGate.acquire(generation.modelId, generation.signal);
  try {
    const response = await ollamaFetch("/api/chat", {
      method: "POST",
      signal: generation.signal,
      body: JSON.stringify({
        model: generation.modelId,
        messages: messages.map(({ role, content }) => ({ role, content })),
        stream: false,
        options: generationOptions(options, 1000),
      }),
    }, timeoutMs);
    if (!response.ok) throw await ollamaHttpError(response);
    const data = await readBoundedJson<{ message?: { content?: string } }>(response);
    const content = data.message?.content?.trim();
    if (!content) throw new ProviderError("empty-output", "Ollama returned an empty response.");
    return content;
  } finally {
    lease.release();
  }
}

export async function streamChatWithOllama(messages: ChatMessage[], options?: GenerationOptions): Promise<ReadableStream<Uint8Array>> {
  const timeoutMs = options?.timeoutMs ?? 120_000;
  const generation = resolvedGeneration(options?.modelId, options?.signal, timeoutMs);
  const lease = await localModelGenerationGate.acquire(generation.modelId, generation.signal);
  let released = false;
  let removeGenerationAbortListener: () => void = () => undefined;
  const release = () => {
    if (released) return;
    released = true;
    removeGenerationAbortListener();
    lease.release();
  };
  try {
    const response = await ollamaFetch("/api/chat", {
      method: "POST",
      signal: generation.signal,
      body: JSON.stringify({
        model: generation.modelId,
        messages: messages.map(({ role, content }) => ({ role, content })),
        stream: true,
        options: generationOptions(options, 1000),
      }),
    }, timeoutMs);

    if (!response.ok) throw await ollamaHttpError(response);

    if (!response.body) throw new ProviderError("empty-output", "Ollama returned an empty response stream");

    const reader = response.body.getReader();
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > OLLAMA_RESPONSE_LIMITS.streamWireBytes) {
      const error = responseLimitError();
      await reader.cancel(error).catch(() => undefined);
      throw error;
    }
    const onGenerationAbort = () => {
      void reader.cancel(generation.signal.reason).catch(() => undefined).finally(release);
    };
    generation.signal.addEventListener("abort", onGenerationAbort, { once: true });
    removeGenerationAbortListener = () => generation.signal.removeEventListener("abort", onGenerationAbort);
    if (generation.signal.aborted) onGenerationAbort();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";
    let emitted = false;
    let wireBytes = 0;
    let partialLineBytes = 0;
    let readChunks = 0;
    let processedLines = 0;
    const output = { bytes: 0, chars: 0 };

    const accountWireChunk = (value: Uint8Array) => {
      wireBytes += value.byteLength;
      if (wireBytes > OLLAMA_RESPONSE_LIMITS.streamWireBytes) throw responseLimitError();
      for (const byte of value) {
        partialLineBytes = byte === 0x0a ? 0 : partialLineBytes + 1;
        if (partialLineBytes > OLLAMA_RESPONSE_LIMITS.streamPartialLineBytes) throw responseLimitError();
      }
    };

    const ensurePartialLineChars = () => {
      if (buffer.length > OLLAMA_RESPONSE_LIMITS.streamPartialLineChars) throw responseLimitError();
    };

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              if (generation.signal.aborted) {
                release();
                controller.error(providerErrorFrom(generation.signal.reason));
                return;
              }
              buffer += decoder.decode();
              ensurePartialLineChars();
              if (buffer.trim()) emitted = processLine(buffer, controller, encoder, output) || emitted;
              release();
              if (emitted) controller.close();
              else controller.error(new ProviderError("empty-output", "Ollama returned an empty response stream."));
              return;
            }

            readChunks += 1;
            if (readChunks > OLLAMA_RESPONSE_LIMITS.streamReadChunks) throw responseLimitError();
            accountWireChunk(value);
            const decoded = buffer + decoder.decode(value, { stream: true });
            let lineStart = 0;
            let lineEnd = decoded.indexOf("\n");
            let emittedThisPull = false;
            while (lineEnd >= 0) {
              processedLines += 1;
              if (processedLines > OLLAMA_RESPONSE_LIMITS.streamLines) throw responseLimitError();
              const lineEmitted = processLine(decoded.slice(lineStart, lineEnd), controller, encoder, output);
              emitted = lineEmitted || emitted;
              emittedThisPull = lineEmitted || emittedThisPull;
              lineStart = lineEnd + 1;
              lineEnd = decoded.indexOf("\n", lineStart);
            }
            buffer = decoded.slice(lineStart);
            ensurePartialLineChars();
            if (emittedThisPull) return;
          }
        } catch (error) {
          const failure = providerErrorFrom(error);
          if (failure.code === "resource-limit") await reader.cancel(failure).catch(() => undefined);
          release();
          controller.error(failure);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          release();
        }
      },
    });
  } catch (error) {
    release();
    throw error;
  }
}

function processLine(
  line: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  output: { bytes: number; chars: number },
) {
  if (!line.trim()) return false;
  let chunk: OllamaStreamChunk;
  try { chunk = JSON.parse(line) as OllamaStreamChunk; }
  catch (error) { throw new ProviderError("invalid-stream", "Ollama returned a malformed stream chunk.", { cause: error }); }
  if (chunk.error) throw new ProviderError("http", chunk.error.slice(0, 1_000));
  const content = chunk.message?.content;
  if (!content || typeof content !== "string") return false;
  const encoded = encoder.encode(content);
  output.bytes += encoded.byteLength;
  output.chars += content.length;
  if (output.bytes > OLLAMA_RESPONSE_LIMITS.streamOutputBytes
    || output.chars > OLLAMA_RESPONSE_LIMITS.streamOutputChars) throw responseLimitError();
  controller.enqueue(encoded);
  return true;
}

export const ollamaProvider: LocalChatProvider = {
  id: "ollama",
  status: getOllamaStatus,
  completeJson: completeJsonWithOllama,
  completeText: completeTextWithOllama,
  stream: streamChatWithOllama,
};
