import { isValidChatMessage, parseAnalysisTraceHeader, parsePackWarningCodesHeader } from "./chat-validation.ts";
import { expertPackFailureCodes } from "./expert-packs.ts";
import { ProviderError, type ChatMessage } from "./providers/types.ts";
import { ConversationTurnError, type ConversationTurnFailureCode } from "./conversation-turns.ts";

export type TurnLifecycleCallbacks = {
  complete(message: ChatMessage): void | Promise<void>;
  cancel(partial: ChatMessage | null): void | Promise<void>;
  fail(code: ConversationTurnFailureCode, message: string, partial: ChatMessage | null): void | Promise<void>;
};

function parseWordArtifact(value: string | null, content: string): ChatMessage["wordArtifact"] {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(decodeURIComponent(value));
    const candidate: ChatMessage = { role: "assistant", content: content.trim() || "Artifact metadata", wordArtifact: parsed };
    return isValidChatMessage(candidate) ? candidate.wordArtifact : undefined;
  } catch {
    return undefined;
  }
}

function parseMemoryTitles(value: string | null) {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(value));
    if (!Array.isArray(parsed) || parsed.length > 8 || !parsed.every((title) => typeof title === "string" && title.length > 0 && title.length <= 80)) return undefined;
    return parsed as string[];
  } catch {
    return undefined;
  }
}

export function assistantMessageFromResponse(content: string, headers: Headers): ChatMessage {
  const artifactIntent = headers.get("X-Rangabot-Artifact-Intent") === "word" ? "word" as const : undefined;
  const wordArtifact = parseWordArtifact(headers.get("X-Rangabot-Word-Artifact"), content);
  const analysisTrace = parseAnalysisTraceHeader(headers.get("X-Rangabot-Analysis")) ?? undefined;
  const packWarnings = analysisTrace?.packId
    ? parsePackWarningCodesHeader(headers.get("X-Rangabot-Pack-Warnings")) ?? undefined
    : undefined;
  const answerDisposition = packWarnings?.length ? "verified-fallback" as const : undefined;
  const retrievalHeader = headers.get("X-Rangabot-Retrieval");
  const retrievalMode = retrievalHeader === "hybrid" || retrievalHeader === "keyword-only" ? retrievalHeader : undefined;
  const memoryHeader = headers.get("X-Rangabot-Memory");
  const memoryUse = memoryHeader === "direct" ? "direct" as const : memoryHeader === "used" ? "context" as const : undefined;
  const memoryTitles = memoryUse ? parseMemoryTitles(headers.get("X-Rangabot-Memory-Titles")) : undefined;
  return {
    role: "assistant",
    content,
    ...(artifactIntent ? { artifactIntent } : {}),
    ...(wordArtifact ? { wordArtifact } : {}),
    ...(analysisTrace ? { analysisTrace } : {}),
    ...(answerDisposition ? { answerDisposition } : {}),
    ...(packWarnings ? { packWarnings } : {}),
    ...(retrievalMode ? { retrievalMode } : {}),
    ...(headers.get("X-Rangabot-Knowledge") === "used" ? { knowledgeUsed: true as const } : {}),
    ...(memoryUse ? { memoryUse } : {}),
    ...(memoryTitles?.length ? { memoryTitles } : {}),
  };
}

export function responseFromCompletedAssistant(message: ChatMessage) {
  const headers = new Headers({
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Rangabot-Turn-Replay": "completed",
  });
  if (message.artifactIntent) headers.set("X-Rangabot-Artifact-Intent", message.artifactIntent);
  if (message.wordArtifact) headers.set("X-Rangabot-Word-Artifact", encodeURIComponent(JSON.stringify(message.wordArtifact)));
  if (message.analysisTrace) headers.set("X-Rangabot-Analysis", encodeURIComponent(JSON.stringify(message.analysisTrace)));
  if (message.packWarnings?.length) headers.set("X-Rangabot-Pack-Warnings", message.packWarnings.join(","));
  if (message.retrievalMode) headers.set("X-Rangabot-Retrieval", message.retrievalMode);
  if (message.knowledgeUsed || message.retrievalMode) headers.set("X-Rangabot-Knowledge", "used");
  if (message.memoryUse) headers.set("X-Rangabot-Memory", message.memoryUse === "direct" ? "direct" : "used");
  if (message.memoryTitles?.length) headers.set("X-Rangabot-Memory-Titles", encodeURIComponent(JSON.stringify(message.memoryTitles)));
  return new Response(message.content, { headers });
}

function partialMessage(content: string, headers: Headers) {
  const message = assistantMessageFromResponse(content, headers);
  return content.trim() || message.wordArtifact ? message : null;
}

function failureFrom(error: unknown): { code: ConversationTurnFailureCode; message: string } {
  if (error instanceof ProviderError) return { code: error.code, message: error.message };
  if (error instanceof DOMException && error.name === "TimeoutError") return { code: "timeout", message: "The local model timed out." };
  if (error instanceof DOMException && error.name === "AbortError") return { code: "cancelled", message: "Generation was stopped." };
  if (error instanceof ConversationTurnError) return { code: "internal", message: "The local answer could not be saved safely." };
  return { code: "internal", message: "The local request failed before completion." };
}

function abortedFailure(signal?: AbortSignal) {
  return signal?.aborted ? failureFrom(signal.reason) : null;
}

export function wrapSuccessfulTurnResponse(response: Response, callbacks: TurnLifecycleCallbacks, signal?: AbortSignal) {
  if (!response.ok || !response.body) throw new Error("A successful response with a body is required.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let content = "";
  let terminal: Promise<void> | null = null;

  const settle = (kind: "complete" | "cancel" | "fail", error?: unknown) => {
    if (terminal) return terminal;
    const operation = (async () => {
      const partial = partialMessage(content, response.headers);
      if (kind === "complete") {
        if (!partial?.content.trim()) {
          throw new ProviderError("empty-output", "The local model returned an empty response.");
        }
        await callbacks.complete(partial);
        return;
      }
      if (kind === "cancel") {
        await callbacks.cancel(partial);
        return;
      }
      const failure = failureFrom(error);
      await callbacks.fail(failure.code, failure.message, partial);
    })();
    terminal = kind === "complete"
      ? operation.catch((error) => {
        // Completion is an atomic persistence attempt. If it rolls back, allow
        // the catch path to record a failed terminal receipt instead.
        terminal = null;
        throw error;
      })
      : operation;
    return terminal;
  };

  const abort = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
    const failure = abortedFailure(signal);
    void settle(failure?.code === "cancelled" ? "cancel" : "fail", signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          content += decoder.decode();
          if (signal?.aborted) {
            const failure = abortedFailure(signal);
            await settle(failure?.code === "cancelled" ? "cancel" : "fail", signal.reason);
            controller.error(signal.reason ?? new DOMException("Stopped", "AbortError"));
            return;
          }
          await settle("complete");
          controller.close();
          return;
        }
        content += decoder.decode(value, { stream: true });
        controller.enqueue(value);
      } catch (error) {
        const signalFailure = abortedFailure(signal);
        if (signalFailure) await settle(signalFailure.code === "cancelled" ? "cancel" : "fail", signal?.reason ?? error);
        else if (failureFrom(error).code === "cancelled") await settle("cancel", error);
        else await settle("fail", error);
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      await settle("cancel", reason);
    },
  });

  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function statusFailureCode(status: number): ConversationTurnFailureCode {
  if (status === 499) return "cancelled";
  if (status === 429) return "busy";
  if (status === 504) return "timeout";
  if (status === 503) return "unavailable";
  if (status >= 400 && status < 500) return "invalid-request";
  return "internal";
}

export async function recordFailedTurnResponse(response: Response, callbacks: TurnLifecycleCallbacks, signal?: AbortSignal) {
  let message = `The local request failed (${response.status}).`;
  let code: ConversationTurnFailureCode = statusFailureCode(response.status);
  try {
    const body = (await response.clone().json()) as { error?: unknown; code?: unknown };
    if (typeof body.error === "string" && body.error.trim()) message = body.error.slice(0, 500);
    if (typeof body.code === "string" && (["unavailable", "model-missing", "busy", "timeout", "cancelled", "http", "empty-output", "invalid-stream", "resource-limit", "invalid-request", "internal", "interrupted"] as string[]).concat(expertPackFailureCodes).includes(body.code)) {
      code = body.code as ConversationTurnFailureCode;
    }
  } catch {
    // The status-derived safe failure remains authoritative.
  }
  const signalFailure = abortedFailure(signal);
  if (signalFailure?.code === "cancelled") await callbacks.cancel(null);
  else if (signalFailure) await callbacks.fail(signalFailure.code, signalFailure.message, null);
  else if (code === "cancelled") await callbacks.cancel(null);
  else await callbacks.fail(code, message, null);
  return response;
}

export async function recordTurnException(error: unknown, callbacks: TurnLifecycleCallbacks, signal?: AbortSignal) {
  const failure = abortedFailure(signal) ?? failureFrom(error);
  if (failure.code === "cancelled") {
    await callbacks.cancel(null);
    return;
  }
  await callbacks.fail(failure.code, failure.message, null);
}
