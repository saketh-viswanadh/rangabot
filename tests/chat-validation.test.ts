import assert from "node:assert/strict";
import test from "node:test";
import { isValidAnalysisTrace, isValidChatMessages, MAX_CHAT_MESSAGES, MAX_CHAT_TOTAL_CHARS, parseAnalysisTraceHeader, parsePackWarningsHeader } from "../lib/chat-validation.ts";

const packTrace = { engine: "duckdb" as const, dataset: "sales.csv", query: "SELECT 1", returnedRows: 1, truncated: false, durationMs: 12, inputSha256: "a".repeat(64), querySha256: "b".repeat(64), packId: "analytics", packVersion: "0.1.0", modelMode: "general" as const, modelId: "local:3b" };

test("accepts bounded chat history and rejects empty generation input", () => {
  assert.equal(isValidChatMessages([{ role: "user", content: "Hello" }]), true);
  assert.equal(isValidChatMessages([]), false);
  assert.equal(isValidChatMessages([], { allowEmpty: true }), true);
});

test("parses only bounded, complete analysis provenance headers", () => {
  const trace = packTrace;
  assert.equal(isValidAnalysisTrace(trace), true);
  assert.deepEqual(parseAnalysisTraceHeader(encodeURIComponent(JSON.stringify(trace))), trace);
  assert.equal(parseAnalysisTraceHeader(encodeURIComponent(JSON.stringify({ ...trace, returnedRows: 201 }))), null);
  assert.equal(parseAnalysisTraceHeader("%not-json"), null);
  assert.equal(parseAnalysisTraceHeader("x".repeat(30_001)), null);
});

test("accepts only known bounded pack warnings as a verified fallback disposition", () => {
  assert.equal(parsePackWarningsHeader("model-narration-unavailable"), "verified-fallback");
  assert.equal(parsePackWarningsHeader("model-narration-unavailable,narration-grounding-rejected"), "verified-fallback");
  assert.equal(parsePackWarningsHeader("model-narration-unavailable,model-narration-unavailable"), null);
  assert.equal(parsePackWarningsHeader("unknown-warning"), null);
  assert.equal(parsePackWarningsHeader("x".repeat(257)), null);
});

test("rejects excessive message counts and aggregate content", () => {
  assert.equal(isValidChatMessages(Array.from({ length: MAX_CHAT_MESSAGES + 1 }, () => ({ role: "user" as const, content: "x" }))), false);
  const oversized = Array.from({ length: 21 }, () => ({ role: "user" as const, content: "x".repeat(Math.floor(MAX_CHAT_TOTAL_CHARS / 20)) }));
  assert.equal(isValidChatMessages(oversized), false);
});

test("rejects unbounded or malformed persisted message metadata", () => {
  assert.equal(isValidChatMessages([{ role: "user", content: "Hello", arbitrary: { payload: "x".repeat(1000) } }]), false);
  assert.equal(isValidChatMessages([{ role: "assistant", content: "Done", wordArtifact: { id: "id", title: "Title", filename: "file.docx", previewPages: 2 } }]), true);
  assert.equal(isValidChatMessages([{ role: "assistant", content: "Your name is Saketh.", memoryUse: "direct" }]), true);
  assert.equal(isValidChatMessages([{ role: "assistant", content: "Done", memoryUse: "inferred" }]), false);
  assert.equal(isValidChatMessages([{ role: "assistant", content: "Done", memoryUse: "context", memoryTitles: ["Answer style"] }]), true);
  assert.equal(isValidChatMessages([{ role: "assistant", content: "Done", memoryTitles: ["x".repeat(81)] }]), false);
  assert.equal(isValidChatMessages([{ role: "assistant", content: "Verified", analysisTrace: { engine: "duckdb", dataset: "sales.csv", query: "SELECT count(*) FROM dataset", returnedRows: 1, truncated: false, durationMs: 12, inputSha256: "a".repeat(64), querySha256: "b".repeat(64) } }]), true);
  assert.equal(isValidChatMessages([{ role: "assistant", content: "Verified", analysisTrace: { engine: "duckdb", dataset: "sales.csv", query: "SELECT count(*) FROM dataset", returnedRows: 1, truncated: false, durationMs: 12, inputSha256: "a".repeat(64), querySha256: "b".repeat(64), packId: "analytics", packVersion: "0.1.0", modelMode: "general", modelId: "local:3b" } }]), true);
  assert.equal(isValidChatMessages([{ role: "assistant", content: "Verified", analysisTrace: packTrace, answerDisposition: "verified-fallback" }]), true);
  assert.equal(isValidChatMessages([{ role: "assistant", content: "Bad", answerDisposition: "verified-fallback" }]), false);
  assert.equal(isValidChatMessages([{ role: "user", content: "Bad", analysisTrace: packTrace, answerDisposition: "verified-fallback" }]), false);
  assert.equal(isValidChatMessages([{ role: "assistant", content: "Bad", analysisTrace: { ...packTrace, packId: undefined, packVersion: undefined, modelMode: undefined, modelId: undefined }, answerDisposition: "verified-fallback" }]), false);
  assert.equal(isValidChatMessages([{ role: "assistant", content: "Bad", analysisTrace: { engine: "duckdb", dataset: "sales.csv", query: "SELECT 1", returnedRows: 1, truncated: false, durationMs: 12, inputSha256: "a".repeat(64), querySha256: "b".repeat(64), packId: "analytics" } }]), false);
  assert.equal(isValidChatMessages([{ role: "assistant", content: "Bad", analysisTrace: { engine: "duckdb", dataset: "sales.csv", query: "SELECT 1", returnedRows: 1, truncated: false, durationMs: 12, inputSha256: "a".repeat(64), querySha256: "b".repeat(64), modelMode: "general", modelId: "local:3b" } }]), false);
  assert.equal(isValidChatMessages([{ role: "assistant", content: "Bad", analysisTrace: { engine: "duckdb", dataset: "sales.csv", query: "SELECT 1", returnedRows: 999, truncated: false, durationMs: 12, inputSha256: "a".repeat(64), querySha256: "b".repeat(64) } }]), false);
  assert.equal(isValidChatMessages([{ role: "assistant", content: "Done", replyTo: { role: "system", excerpt: "bad" } }]), false);
});
