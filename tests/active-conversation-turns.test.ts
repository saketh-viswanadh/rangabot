import assert from "node:assert/strict";
import test from "node:test";
import { ActiveConversationTurnRegistry } from "../lib/active-conversation-turns.ts";

test("server cancellation aborts the exact active turn and release removes it", () => {
  const registry = new ActiveConversationTurnRegistry();
  const active = registry.register("turn-a");
  const reason = new DOMException("Stopped", "AbortError");

  assert.equal(registry.has("turn-a"), true);
  assert.equal(registry.abort("turn-a", reason), true);
  assert.equal(active.signal.aborted, true);
  assert.equal(active.signal.reason, reason);
  assert.equal(registry.abort("turn-b"), false);

  active.release();
  active.release();
  assert.equal(registry.has("turn-a"), false);
});

test("request and deadline aborts propagate through the server-owned signal", () => {
  const registry = new ActiveConversationTurnRegistry();
  const request = new AbortController();
  const deadline = new AbortController();
  const active = registry.register("turn-a", [request.signal, deadline.signal]);
  const reason = new DOMException("Timed out", "TimeoutError");

  deadline.abort(reason);
  assert.equal(active.signal.aborted, true);
  assert.equal(active.signal.reason, reason);
  active.release();
});

test("duplicate ownership is rejected and a released id can be registered again", () => {
  const registry = new ActiveConversationTurnRegistry();
  const first = registry.register("turn-a");
  assert.throws(() => registry.register("turn-a"), /already owns an active generation/);
  first.release();
  const second = registry.register("turn-a");
  assert.equal(second.signal.aborted, false);
  second.release();
});

test("release detaches upstream abort listeners", () => {
  const registry = new ActiveConversationTurnRegistry();
  const upstream = new AbortController();
  const active = registry.register("turn-a", [upstream.signal]);
  active.release();
  upstream.abort(new DOMException("Stopped", "AbortError"));
  assert.equal(active.signal.aborted, false);
});
