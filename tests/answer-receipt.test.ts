import assert from "node:assert/strict";
import test from "node:test";
import { formatAnswerReceipt } from "../lib/answer-receipt.ts";

test("shows ordinary approved-memory context without claiming direct recall", () => {
  assert.equal(formatAnswerReceipt({ memoryUse: "context" }), "LOCAL · MEMORY");
});

test("distinguishes deterministic memory recall", () => {
  assert.equal(formatAnswerReceipt({ memoryUse: "direct" }), "LOCAL · MEMORY · DIRECT RECALL");
});

test("combines knowledge and memory receipts without hiding retrieval mode", () => {
  assert.equal(formatAnswerReceipt({ knowledgeUsed: true, retrievalMode: "hybrid", memoryUse: "context" }), "LOCAL · KNOWLEDGE VAULT · HYBRID · MEMORY");
});

test("discloses relevant memories by title only", () => {
  assert.equal(formatAnswerReceipt({ memoryUse: "context", memoryTitles: ["Answer style", "Technical preference"] }), "LOCAL · MEMORY · Answer style · Technical preference");
});
