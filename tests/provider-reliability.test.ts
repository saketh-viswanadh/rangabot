import assert from "node:assert/strict";
import test from "node:test";
import { ProviderError } from "../lib/providers/types.ts";
import { completeTextWithOllama, ollamaProvider, providerErrorFrom, streamChatWithOllama } from "../lib/providers/ollama.ts";

async function withFetch(mock: typeof fetch, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { await run(); }
  finally { globalThis.fetch = original; }
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

test("propagates cancellation without retrying local generation", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await withFetch(async (_input, init) => {
    calls += 1;
    throw init?.signal?.reason ?? new DOMException("stopped", "AbortError");
  }, async () => {
    await assert.rejects(ollamaProvider.completeText([{ role: "user", content: "hello" }], { signal: controller.signal }), (error: unknown) => error instanceof ProviderError && error.code === "cancelled");
  });
  assert.equal(calls, 1);
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
