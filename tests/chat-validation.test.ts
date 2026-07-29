import assert from "node:assert/strict";
import test from "node:test";
import { isValidChatMessages, MAX_CHAT_MESSAGES, MAX_CHAT_TOTAL_CHARS } from "../lib/chat-validation.ts";

test("accepts bounded chat history and rejects empty generation input", () => {
  assert.equal(isValidChatMessages([{ role: "user", content: "Hello" }]), true);
  assert.equal(isValidChatMessages([]), false);
  assert.equal(isValidChatMessages([], { allowEmpty: true }), true);
});

test("rejects excessive message counts and aggregate content", () => {
  assert.equal(isValidChatMessages(Array.from({ length: MAX_CHAT_MESSAGES + 1 }, () => ({ role: "user" as const, content: "x" }))), false);
  const oversized = Array.from({ length: 21 }, () => ({ role: "user" as const, content: "x".repeat(Math.floor(MAX_CHAT_TOTAL_CHARS / 20)) }));
  assert.equal(isValidChatMessages(oversized), false);
});

test("rejects unbounded or malformed persisted message metadata", () => {
  assert.equal(isValidChatMessages([{ role: "user", content: "Hello", arbitrary: { payload: "x".repeat(1000) } }]), false);
  assert.equal(isValidChatMessages([{ role: "assistant", content: "Done", wordArtifact: { id: "id", title: "Title", filename: "file.docx", previewPages: 2 } }]), true);
  assert.equal(isValidChatMessages([{ role: "assistant", content: "Done", replyTo: { role: "system", excerpt: "bad" } }]), false);
});
