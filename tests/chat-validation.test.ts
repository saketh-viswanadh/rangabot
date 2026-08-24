import assert from "node:assert/strict";
import test from "node:test";
import { isValidAnalysisTrace, isValidCapabilityReceipt, isValidChatMessages, isValidFinishVerification, MAX_CHAT_MESSAGES, MAX_CHAT_TOTAL_CHARS, parseAnalysisTraceHeader, parseCapabilityReceiptHeader, parseFinishVerificationHeader, parsePackWarningCodesHeader, parsePackWarningsHeader } from "../lib/chat-validation.ts";

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
  assert.deepEqual(parsePackWarningCodesHeader("narration-grounding-rejected"), ["narration-grounding-rejected"]);
});

test("accepts only bounded internally generated finish receipts", () => {
  const receipt = { version: "finish-v1", status: "repaired", checks: ["completion", "requirements"], issueCount: 0 };
  assert.equal(isValidFinishVerification(receipt), true);
  assert.deepEqual(parseFinishVerificationHeader(encodeURIComponent(JSON.stringify(receipt))), receipt);
  assert.equal(isValidFinishVerification({ ...receipt, checks: ["completion", "completion"] }), false);
  assert.equal(isValidFinishVerification({ ...receipt, status: "passed", issueCount: 1 }), false);
  const manual = { version: "finish-v1", status: "warning", checks: ["completion", "requirements"], issueCount: 1, manualReview: "ambiguous-sentence-boundary" };
  assert.equal(isValidFinishVerification(manual), true);
  assert.deepEqual(parseFinishVerificationHeader(encodeURIComponent(JSON.stringify(manual))), manual);
  assert.equal(isValidFinishVerification({ ...manual, status: "passed", issueCount: 0 }), false);
  assert.equal(isValidFinishVerification({ ...manual, checks: ["completion"] }), false);
  assert.equal(isValidFinishVerification({ ...manual, checks: ["requirements"] }), false);
  assert.equal(isValidFinishVerification({ ...manual, checks: ["requirements", "completion"] }), false);
  assert.equal(isValidFinishVerification({ ...manual, manualReview: "free-form" }), false);
  assert.equal(parseFinishVerificationHeader("%not-json"), null);
  assert.equal(isValidFinishVerification({ version: "finish-v1", status: "passed", checks: ["completion"], issueCount: 0 }), true);
});

test("accepts only bounded privacy-safe capability receipts", () => {
  const receipt = { version: "capability-route-v1", status: "selected", route: "analytics", contexts: ["dataset"], reasons: ["attached-data-analysis"] };
  assert.equal(isValidCapabilityReceipt(receipt), true);
  assert.deepEqual(parseCapabilityReceiptHeader(encodeURIComponent(JSON.stringify(receipt))), receipt);
  const failedAttempt = { ...receipt, contexts: [], attemptedContexts: ["dataset"] };
  assert.equal(isValidCapabilityReceipt(failedAttempt), true);
  assert.deepEqual(parseCapabilityReceiptHeader(encodeURIComponent(JSON.stringify(failedAttempt))), failedAttempt);
  assert.equal(isValidCapabilityReceipt({ ...receipt, contexts: [] }), false);
  assert.equal(isValidCapabilityReceipt({ ...receipt, attemptedContexts: [] }), false);
  assert.equal(isValidCapabilityReceipt({ ...failedAttempt, attemptedContexts: ["dataset", "dataset"] }), false);
  assert.equal(isValidCapabilityReceipt({ ...receipt, route: "direct-memory", contexts: [], attemptedContexts: [], reasons: ["explicit-memory-recall"] }), false);
  assert.equal(isValidCapabilityReceipt({ ...receipt, route: "direct-memory", contexts: [], attemptedContexts: undefined, reasons: ["explicit-memory-recall"] }), false);
  assert.equal(isValidCapabilityReceipt({ ...receipt, route: "repository-context", contexts: [], attemptedContexts: [], reasons: ["attached-repository-context"] }), false);
  assert.equal(isValidCapabilityReceipt({ ...receipt, route: "repository-context", contexts: [], attemptedContexts: undefined, reasons: ["attached-repository-context"] }), false);
  assert.equal(isValidCapabilityReceipt({ ...receipt, route: "knowledge-vault", contexts: [], attemptedContexts: [], reasons: ["explicit-vault-request"] }), false);
  assert.equal(isValidCapabilityReceipt({ ...receipt, route: "knowledge-vault", contexts: [], attemptedContexts: undefined, reasons: ["explicit-vault-request"] }), false);
  assert.equal(isValidCapabilityReceipt({ ...receipt, route: "word-document", contexts: [], attemptedContexts: [], reasons: ["explicit-word-artifact", "attached-repository-context"] }), false);
  assert.equal(isValidCapabilityReceipt({ ...receipt, contexts: ["dataset", "dataset"] }), false);
  assert.equal(isValidCapabilityReceipt({ ...receipt, route: "clarification" }), false);
  assert.equal(isValidCapabilityReceipt({ ...receipt, route: "conversation", reasons: ["ordinary-conversation"] }), false);
  assert.equal(isValidCapabilityReceipt({ ...receipt, route: "unavailable", status: "unavailable", contexts: ["approved-memory"], reasons: ["cloud-handoff-disabled"] }), false);
  assert.equal(isValidCapabilityReceipt({ ...receipt, route: "word-document", contexts: ["dataset"], reasons: ["explicit-word-artifact"] }), false);
  assert.equal(isValidCapabilityReceipt({ ...receipt, route: "clarification", status: "clarify", contexts: ["dataset"], reasons: ["multiple-material-capabilities"] }), false);
  assert.equal(isValidCapabilityReceipt({ ...receipt, privatePath: "/secret" }), false);
  assert.equal(parseCapabilityReceiptHeader("%not-json"), null);
});

test("accepts only feasible explicit Knowledge Vault attempt prefixes", () => {
  const combined = {
    version: "capability-route-v1",
    status: "selected",
    route: "knowledge-vault",
    reasons: ["explicit-vault-request", "attached-repository-context"],
  };
  const repositoryFailure = { ...combined, contexts: [], attemptedContexts: ["repository"] };
  assert.equal(isValidCapabilityReceipt(repositoryFailure), true);
  assert.deepEqual(parseCapabilityReceiptHeader(encodeURIComponent(JSON.stringify(repositoryFailure))), repositoryFailure);
  assert.equal(isValidCapabilityReceipt({ ...combined, contexts: ["repository"], attemptedContexts: ["repository", "knowledge-vault"] }), true);
  assert.equal(isValidCapabilityReceipt({ ...combined, contexts: ["repository", "knowledge-vault"], attemptedContexts: ["repository", "knowledge-vault", "approved-memory"] }), true);
  assert.equal(isValidCapabilityReceipt({ ...combined, contexts: [], attemptedContexts: [] }), false);
  assert.equal(isValidCapabilityReceipt({ ...combined, contexts: [], attemptedContexts: ["knowledge-vault"] }), false);
  assert.equal(isValidCapabilityReceipt({ ...combined, contexts: [], attemptedContexts: ["repository", "approved-memory"] }), false);
  assert.equal(isValidCapabilityReceipt({ ...combined, contexts: ["repository"], attemptedContexts: ["knowledge-vault", "repository"] }), false);
  assert.equal(isValidCapabilityReceipt({ ...combined, contexts: ["repository"], attemptedContexts: ["repository", "knowledge-vault", "approved-memory"] }), false);
  assert.equal(isValidCapabilityReceipt({ ...combined, contexts: ["repository", "knowledge-vault"], attemptedContexts: ["repository", "approved-memory", "knowledge-vault"] }), false);
  assert.equal(isValidCapabilityReceipt({ ...combined, contexts: ["repository"], attemptedContexts: ["repository"] }), false);
  assert.equal(isValidCapabilityReceipt({ ...combined, reasons: ["explicit-vault-request"], contexts: [], attemptedContexts: ["repository"] }), false);
  assert.equal(isValidCapabilityReceipt({ ...combined, reasons: ["explicit-vault-request"], contexts: [], attemptedContexts: ["knowledge-vault", "approved-memory"] }), false);
});

test("receipt validation enforces real repository, Vault, Word, and memory execution order", () => {
  const repository = { version: "capability-route-v1", status: "selected", route: "repository-context", reasons: ["attached-repository-context"] };
  assert.equal(isValidCapabilityReceipt({ ...repository, contexts: [], attemptedContexts: ["repository"] }), true);
  assert.equal(isValidCapabilityReceipt({ ...repository, contexts: ["repository"], attemptedContexts: ["repository", "approved-memory"] }), true);
  assert.equal(isValidCapabilityReceipt({ ...repository, contexts: ["repository", "approved-memory"], attemptedContexts: ["repository", "approved-memory"] }), true);
  assert.equal(isValidCapabilityReceipt({ ...repository, contexts: [], attemptedContexts: ["repository", "approved-memory"] }), false);
  assert.equal(isValidCapabilityReceipt({ ...repository, contexts: ["approved-memory"], attemptedContexts: ["repository", "approved-memory"] }), false);
  assert.equal(isValidCapabilityReceipt({ ...repository, contexts: ["approved-memory"] }), false);

  const word = { version: "capability-route-v1", status: "selected", route: "word-document", reasons: ["explicit-word-artifact"] };
  assert.equal(isValidCapabilityReceipt({ ...word, contexts: ["repository"] }), false);
  assert.equal(isValidCapabilityReceipt({ ...word, contexts: [], attemptedContexts: [] }), true);
  assert.equal(isValidCapabilityReceipt({ ...word, reasons: ["explicit-word-artifact", "attached-repository-context"], contexts: ["repository"] }), true);

  const vault = { version: "capability-route-v1", status: "selected", route: "knowledge-vault", reasons: ["explicit-vault-request"] };
  assert.equal(isValidCapabilityReceipt({ ...vault, contexts: ["repository"] }), false);
  assert.equal(isValidCapabilityReceipt({ ...vault, contexts: ["approved-memory"] }), false);
  assert.equal(isValidCapabilityReceipt({ ...vault, contexts: ["knowledge-vault", "approved-memory"] }), true);
  assert.equal(isValidCapabilityReceipt({ ...vault, contexts: [], attemptedContexts: ["knowledge-vault", "approved-memory"] }), false);
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
  assert.equal(isValidChatMessages([{ role: "assistant", content: "Done", finishVerification: { version: "finish-v1", status: "passed", checks: ["completion", "arithmetic"], issueCount: 0 } }]), true);
  assert.equal(isValidChatMessages([{ role: "assistant", content: "Done", capabilityReceipt: { version: "capability-route-v1", status: "selected", route: "conversation", contexts: [], reasons: ["ordinary-conversation"] } }]), true);
  assert.equal(isValidChatMessages([{ role: "user", content: "Bad", capabilityReceipt: { version: "capability-route-v1", status: "selected", route: "conversation", contexts: [], reasons: ["ordinary-conversation"] } }]), false);
  assert.equal(isValidChatMessages([{ role: "user", content: "Bad", finishVerification: { version: "finish-v1", status: "passed", checks: ["completion", "arithmetic"], issueCount: 0 } }]), false);
  assert.equal(isValidChatMessages([{ role: "assistant", content: "Done", memoryTitles: ["x".repeat(81)] }]), false);
  assert.equal(isValidChatMessages([{ role: "assistant", content: "Verified", analysisTrace: { engine: "duckdb", dataset: "sales.csv", query: "SELECT count(*) FROM dataset", returnedRows: 1, truncated: false, durationMs: 12, inputSha256: "a".repeat(64), querySha256: "b".repeat(64) } }]), true);
  assert.equal(isValidChatMessages([{ role: "assistant", content: "Verified", analysisTrace: { engine: "duckdb", dataset: "sales.csv", query: "SELECT count(*) FROM dataset", returnedRows: 1, truncated: false, durationMs: 12, inputSha256: "a".repeat(64), querySha256: "b".repeat(64), packId: "analytics", packVersion: "0.1.0", modelMode: "general", modelId: "local:3b" } }]), true);
  assert.equal(isValidChatMessages([{ role: "assistant", content: "Verified", analysisTrace: packTrace, answerDisposition: "verified-fallback" }]), true);
  assert.equal(isValidChatMessages([{ role: "assistant", content: "Verified", analysisTrace: packTrace, answerDisposition: "verified-fallback", packWarnings: ["narration-grounding-rejected"] }]), true);
  assert.equal(isValidChatMessages([{ role: "assistant", content: "Bad", analysisTrace: packTrace, packWarnings: ["narration-grounding-rejected"] }]), false);
  assert.equal(isValidChatMessages([{ role: "assistant", content: "Bad", answerDisposition: "verified-fallback" }]), false);
  assert.equal(isValidChatMessages([{ role: "user", content: "Bad", analysisTrace: packTrace, answerDisposition: "verified-fallback" }]), false);
  assert.equal(isValidChatMessages([{ role: "assistant", content: "Bad", analysisTrace: { ...packTrace, packId: undefined, packVersion: undefined, modelMode: undefined, modelId: undefined }, answerDisposition: "verified-fallback" }]), false);
  assert.equal(isValidChatMessages([{ role: "assistant", content: "Bad", analysisTrace: { engine: "duckdb", dataset: "sales.csv", query: "SELECT 1", returnedRows: 1, truncated: false, durationMs: 12, inputSha256: "a".repeat(64), querySha256: "b".repeat(64), packId: "analytics" } }]), false);
  assert.equal(isValidChatMessages([{ role: "assistant", content: "Bad", analysisTrace: { engine: "duckdb", dataset: "sales.csv", query: "SELECT 1", returnedRows: 1, truncated: false, durationMs: 12, inputSha256: "a".repeat(64), querySha256: "b".repeat(64), modelMode: "general", modelId: "local:3b" } }]), false);
  assert.equal(isValidChatMessages([{ role: "assistant", content: "Bad", analysisTrace: { engine: "duckdb", dataset: "sales.csv", query: "SELECT 1", returnedRows: 999, truncated: false, durationMs: 12, inputSha256: "a".repeat(64), querySha256: "b".repeat(64) } }]), false);
  assert.equal(isValidChatMessages([{ role: "assistant", content: "Done", replyTo: { role: "system", excerpt: "bad" } }]), false);
});
