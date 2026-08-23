import assert from "node:assert/strict";
import test from "node:test";
import { ProviderError } from "../lib/providers/types.ts";
import { OLLAMA_RESPONSE_LIMITS, completeTextWithOllama, ollamaProvider, providerErrorFrom, streamChatWithOllama } from "../lib/providers/ollama.ts";

async function withFetch(mock: typeof fetch, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { await run(); }
  finally { globalThis.fetch = original; }
}

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("Timed out waiting for the fake provider state.");
}

test("exposes a typed model-independent local provider boundary", () => {
  assert.equal(ollamaProvider.id, "ollama");
  assert.equal(typeof ollamaProvider.status, "function");
  assert.equal(typeof ollamaProvider.completeText, "function");
  assert.equal(typeof ollamaProvider.stream, "function");
});

test("classifies cancellation, timeout, and unavailable failures", () => {
  assert.equal(providerErrorFrom(new DOMException("stopped", "AbortError")).code, "cancelled");
  assert.equal(providerErrorFrom(new DOMException("late", "TimeoutError")).code, "timeout");
  assert.equal(providerErrorFrom(new Error("offline")).code, "unavailable");
  const original = new ProviderError("model-missing", "missing");
  assert.equal(providerErrorFrom(original), original);
});

test("rejects pre-cancelled generation before contacting the local provider", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await withFetch(async (_input, init) => {
    calls += 1;
    throw init?.signal?.reason ?? new DOMException("stopped", "AbortError");
  }, async () => {
    await assert.rejects(ollamaProvider.completeText([{ role: "user", content: "hello" }], { signal: controller.signal }), (error: unknown) => error instanceof ProviderError && error.code === "cancelled");
  });
  assert.equal(calls, 0);
});

test("enforces one absolute timeout without a second generation attempt", async () => {
  let calls = 0;
  await withFetch((_input, init) => new Promise((_resolve, reject) => {
    calls += 1;
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  }), async () => {
    await assert.rejects(completeTextWithOllama([{ role: "user", content: "hello" }], { timeoutMs: 15 }), (error: unknown) => error instanceof ProviderError && error.code === "timeout");
  });
  assert.equal(calls, 1);
});

test("sends the same explicit context budget to every model", async () => {
  let requestBody = "";
  await withFetch(async (_input, init) => {
    requestBody = String(init?.body);
    return Response.json({ message: { content: "ok" } });
  }, async () => {
    assert.equal(await completeTextWithOllama([{ role: "user", content: "hello" }], { numContext: 2048 }), "ok");
  });
  assert.deepEqual((JSON.parse(requestBody) as { options?: unknown }).options, { num_predict: 1000, num_ctx: 2048 });
});

test("passes explicit deterministic generation controls without changing defaults", async () => {
  let requestBody = "";
  await withFetch(async (_input, init) => {
    requestBody = String(init?.body);
    return Response.json({ message: { content: "ok" } });
  }, async () => {
    assert.equal(await completeTextWithOllama([{ role: "user", content: "hello" }], { temperature: 0, seed: 17 }), "ok");
  });
  assert.deepEqual((JSON.parse(requestBody) as { options?: unknown }).options, { num_predict: 1000, num_ctx: 4096, temperature: 0, seed: 17 });
});

test("uses the explicitly resolved pack model instead of a hidden provider default", async () => {
  let requestBody = "";
  await withFetch(async (_input, init) => {
    requestBody = String(init?.body);
    return Response.json({ message: { content: "ok" } });
  }, async () => {
    assert.equal(await completeTextWithOllama([{ role: "user", content: "hello" }], { modelId: "approved-local:7b" }), "ok");
  });
  assert.equal((JSON.parse(requestBody) as { model?: string }).model, "approved-local:7b");
});

test("integrated provider work for the same resolved model never overlaps", async () => {
  const pending: Array<() => void> = [];
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  await withFetch(async () => {
    calls += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise<void>((resolve) => pending.push(resolve));
    active -= 1;
    return Response.json({ message: { content: "ok" } });
  }, async () => {
    const first = completeTextWithOllama([{ role: "user", content: "first" }], { modelId: "gate-integration-model" });
    await waitFor(() => calls === 1);
    const second = completeTextWithOllama([{ role: "user", content: "second" }], { modelId: "gate-integration-model" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    pending.shift()?.();
    await first;
    await waitFor(() => calls === 2);
    pending.shift()?.();
    await second;
  });
  assert.equal(maximumActive, 1);
});

test("a streaming generation holds model capacity until its body is cancelled", async () => {
  let calls = 0;
  await withFetch(async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"message":{"content":"partial"}}\n'));
        },
      }));
    }
    return Response.json({ message: { content: "next" } });
  }, async () => {
    const stream = await streamChatWithOllama(
      [{ role: "user", content: "stream" }],
      { modelId: "stream-gate-integration-model" },
    );
    const reader = stream.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), "partial");
    const queued = completeTextWithOllama(
      [{ role: "user", content: "next" }],
      { modelId: "stream-gate-integration-model" },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    await reader.cancel(new DOMException("Stopped", "AbortError"));
    assert.equal(await queued, "next");
  });
  assert.equal(calls, 2);
});

test("classifies missing models and empty buffered output", async () => {
  await withFetch(async () => new Response("missing", { status: 404 }), async () => {
    await assert.rejects(completeTextWithOllama([{ role: "user", content: "hello" }]), (error: unknown) => error instanceof ProviderError && error.code === "model-missing");
  });
  await withFetch(async () => Response.json({ message: { content: "  " } }), async () => {
    await assert.rejects(completeTextWithOllama([{ role: "user", content: "hello" }]), (error: unknown) => error instanceof ProviderError && error.code === "empty-output");
  });
});

test("classifies an unreachable local runtime and HTTP failures", async () => {
  await withFetch(async () => { throw new TypeError("connection refused"); }, async () => {
    await assert.rejects(completeTextWithOllama([{ role: "user", content: "hello" }]), (error: unknown) => error instanceof ProviderError && error.code === "unavailable");
  });
  await withFetch(async () => new Response("broken", { status: 500 }), async () => {
    await assert.rejects(completeTextWithOllama([{ role: "user", content: "hello" }]), (error: unknown) => error instanceof ProviderError && error.code === "http");
  });
});

test("bounds successful buffered bodies and cancels the reader without retrying", async () => {
  let calls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(OLLAMA_RESPONSE_LIMITS.bufferedBodyBytes + 1));
    },
    cancel() { cancelled = true; },
  });
  await withFetch(async () => {
    calls += 1;
    return new Response(body);
  }, async () => {
    await assert.rejects(
      completeTextWithOllama([{ role: "user", content: "hello" }], { modelId: "buffer-limit-model" }),
      (error: unknown) => error instanceof ProviderError && error.code === "resource-limit",
    );
  });
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
});

test("bounds oversized HTTP error bodies without reflecting or retrying them", async () => {
  let calls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("sensitive-detail".repeat(Math.ceil(OLLAMA_RESPONSE_LIMITS.errorBodyBytes / 16) + 2)));
    },
    cancel() { cancelled = true; },
  });
  await withFetch(async () => {
    calls += 1;
    return new Response(body, { status: 500 });
  }, async () => {
    await assert.rejects(
      completeTextWithOllama([{ role: "user", content: "hello" }], { modelId: "error-limit-model" }),
      (error: unknown) => error instanceof ProviderError
        && error.code === "resource-limit"
        && !error.message.includes("sensitive-detail"),
    );
  });
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
});

test("rejects empty and malformed streams visibly", async () => {
  await withFetch(async () => new Response(new ReadableStream({ start(controller) { controller.close(); } })), async () => {
    const stream = await streamChatWithOllama([{ role: "user", content: "hello" }]);
    await assert.rejects(stream.getReader().read(), (error: unknown) => error instanceof ProviderError && error.code === "empty-output");
  });
  await withFetch(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("not-json\n")); controller.close(); } })), async () => {
    const stream = await streamChatWithOllama([{ role: "user", content: "hello" }]);
    await assert.rejects(stream.getReader().read(), (error: unknown) => error instanceof ProviderError && error.code === "invalid-stream");
  });
});

test("preserves a partial chunk before surfacing a malformed stream", async () => {
  let step = 0;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (step === 0) controller.enqueue(new TextEncoder().encode('{"message":{"content":"partial"}}\n'));
      else if (step === 1) controller.enqueue(new TextEncoder().encode("not-json\n"));
      else controller.close();
      step += 1;
    },
  });
  await withFetch(async () => new Response(source), async () => {
    const reader = (await streamChatWithOllama([{ role: "user", content: "hello" }])).getReader();
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), "partial");
    await assert.rejects(reader.read(), (error: unknown) => error instanceof ProviderError && error.code === "invalid-stream");
  });
});

test("cancels a streaming reader when a no-newline partial line exceeds its bound", async () => {
  let cancelledWith: unknown;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(OLLAMA_RESPONSE_LIMITS.streamPartialLineBytes + 1)));
    },
    cancel(reason) { cancelledWith = reason; },
  });
  await withFetch(async () => new Response(source), async () => {
    const reader = (await streamChatWithOllama(
      [{ role: "user", content: "hello" }],
      { modelId: "partial-line-limit-model" },
    )).getReader();
    await assert.rejects(
      reader.read(),
      (error: unknown) => error instanceof ProviderError && error.code === "resource-limit",
    );
  });
  assert.ok(cancelledWith instanceof ProviderError);
  assert.equal(cancelledWith.code, "resource-limit");
});

test("bounds a no-newline partial line accumulated across otherwise small chunks", async () => {
  let cancelledWith: unknown;
  let sent = 0;
  const chunk = new TextEncoder().encode("x".repeat(32 * 1024));
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel(reason) { cancelledWith = reason; },
  });
  await withFetch(async () => new Response(source), async () => {
    const reader = (await streamChatWithOllama(
      [{ role: "user", content: "hello" }],
      { modelId: "accumulated-line-limit-model" },
    )).getReader();
    await assert.rejects(
      reader.read(),
      (error: unknown) => error instanceof ProviderError && error.code === "resource-limit",
    );
  });
  assert.ok(sent > OLLAMA_RESPONSE_LIMITS.streamPartialLineBytes);
  assert.ok(cancelledWith instanceof ProviderError);
  assert.equal(cancelledWith.code, "resource-limit");
});

test("bounds cumulative streamed output across individually valid chunks", async () => {
  let cancelledWith: unknown;
  const content = "a".repeat(64 * 1024);
  const lines = Array.from(
    { length: Math.ceil(OLLAMA_RESPONSE_LIMITS.streamOutputBytes / content.length) + 1 },
    () => `${JSON.stringify({ message: { content } })}\n`,
  ).join("");
  const source = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(lines)); },
    cancel(reason) { cancelledWith = reason; },
  });
  await withFetch(async () => new Response(source), async () => {
    const reader = (await streamChatWithOllama(
      [{ role: "user", content: "hello" }],
      { modelId: "total-output-limit-model" },
    )).getReader();
    await assert.rejects(async () => {
      while (!(await reader.read()).done) { /* drain until the terminal limit */ }
    }, (error: unknown) => error instanceof ProviderError && error.code === "resource-limit");
  });
  assert.ok(cancelledWith instanceof ProviderError);
  assert.equal(cancelledWith.code, "resource-limit");
});
