import assert from "node:assert/strict";
import test from "node:test";
import { ModelGenerationGate } from "../lib/model-generation-gate.ts";
import { ProviderError } from "../lib/providers/types.ts";

function nextTurn() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

test("serializes work for one model and transfers the slot in FIFO order", async () => {
  const gate = new ModelGenerationGate(1, 3);
  const first = await gate.acquire("model-a");
  const order: string[] = [];
  const secondPromise = gate.acquire("model-a").then((lease) => {
    order.push("second");
    return lease;
  });
  const thirdPromise = gate.acquire("model-a").then((lease) => {
    order.push("third");
    return lease;
  });

  await nextTurn();
  assert.deepEqual(order, []);
  first.release();
  const second = await secondPromise;
  assert.deepEqual(order, ["second"]);
  await nextTurn();
  assert.deepEqual(order, ["second"]);
  second.release();
  const third = await thirdPromise;
  assert.deepEqual(order, ["second", "third"]);
  third.release();
});

test("rejects queue overflow with a typed busy failure", async () => {
  const gate = new ModelGenerationGate(1, 1);
  const active = await gate.acquire("model-a");
  const queued = gate.acquire("model-a");
  await assert.rejects(
    gate.acquire("model-a"),
    (error: unknown) => error instanceof ProviderError && error.code === "busy",
  );
  active.release();
  (await queued).release();
});

test("removes an aborted waiter without consuming the next capacity slot", async () => {
  const gate = new ModelGenerationGate(1, 2);
  const active = await gate.acquire("model-a");
  const controller = new AbortController();
  const cancelled = gate.acquire("model-a", controller.signal);
  const next = gate.acquire("model-a");
  controller.abort(new DOMException("Stopped", "AbortError"));

  await assert.rejects(cancelled, (error: unknown) => error instanceof ProviderError && error.code === "cancelled");
  active.release();
  (await next).release();

  const after = await gate.acquire("model-a");
  after.release();
});

test("preserves timeout classification for a queued request", async () => {
  const gate = new ModelGenerationGate(1, 1);
  const active = await gate.acquire("model-a");
  const controller = new AbortController();
  const queued = gate.acquire("model-a", controller.signal);
  controller.abort(new DOMException("Late", "TimeoutError"));
  await assert.rejects(queued, (error: unknown) => error instanceof ProviderError && error.code === "timeout");
  active.release();
});

test("does not serialize independently resolved model ids", async () => {
  const gate = new ModelGenerationGate(1, 0);
  const first = await gate.acquire("model-a");
  const second = await gate.acquire("model-b");
  first.release();
  second.release();
});
