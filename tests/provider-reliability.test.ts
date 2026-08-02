import assert from "node:assert/strict";
import test from "node:test";
import { ProviderError } from "../lib/providers/types.ts";
import { ollamaProvider, providerErrorFrom, shouldRetryProviderError } from "../lib/providers/ollama.ts";

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

test("propagates an already-cancelled request into local generation", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(ollamaProvider.completeText([{ role: "user", content: "hello" }], { signal: controller.signal }), (error: unknown) => error instanceof ProviderError && error.code === "cancelled");
});

test("retries only the first safe timeout and never a cancellation", () => {
  const timeout = new DOMException("late", "TimeoutError");
  assert.equal(shouldRetryProviderError(timeout, undefined, 0), true);
  assert.equal(shouldRetryProviderError(timeout, undefined, 1), false);
  const controller = new AbortController(); controller.abort();
  assert.equal(shouldRetryProviderError(timeout, controller.signal, 0), false);
  assert.equal(shouldRetryProviderError(new DOMException("stop", "AbortError"), undefined, 0), false);
});
