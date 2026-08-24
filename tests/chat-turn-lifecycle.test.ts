import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  recordFailedTurnResponse,
  responseFromCompletedAssistant,
  wrapSuccessfulTurnResponse,
  type TurnLifecycleCallbacks,
} from "../lib/chat-turn-lifecycle.ts";
import { ProviderError, type ChatMessage } from "../lib/providers/types.ts";

const testDatabase = resolve("data/chat-turn-lifecycle-test.db");
for (const suffix of ["", "-shm", "-wal"]) rmSync(`${testDatabase}${suffix}`, { force: true });
const conversations = await import("../lib/conversations.ts");
const turns = await import("../lib/conversation-turns.ts");
conversations.setConversationDatabasePathForTests(testDatabase);

test.after(() => {
  conversations.closeConversationDatabaseForTests();
  for (const suffix of ["", "-shm", "-wal"]) rmSync(`${testDatabase}${suffix}`, { force: true });
});

function startTurn(content: string) {
  const conversation = conversations.createConversation([]);
  const turnId = randomUUID();
  turns.beginConversationTurn({
    id: turnId,
    conversationId: conversation.id,
    userMessage: { role: "user", content },
    options: { mode: "smart" },
  });
  const claim = turns.claimConversationTurn(conversation.id, turnId);
  assert.equal(claim.kind, "claimed");
  return { conversation, turnId };
}

function databaseCallbacks(turnId: string): TurnLifecycleCallbacks {
  return {
    complete: (message) => { turns.completeConversationTurn(turnId, message); },
    cancel: (partial) => { turns.cancelConversationTurn(turnId, partial); },
    fail: (code, message, partial) => { turns.failConversationTurn(turnId, code, message, partial); },
  };
}

function chunkedTextResponse(chunks: string[], headers?: HeadersInit) {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk === undefined) controller.close();
      else controller.enqueue(encoder.encode(chunk));
    },
  }), { headers });
}

test("a successful stream commits before EOF and preserves allowlisted response metadata", async () => {
  const { conversation, turnId } = startTurn("Teach me one useful fact.");
  const response = chunkedTextResponse(["A useful ", "completed answer."], {
    "X-Rangabot-Knowledge": "used",
    "X-Rangabot-Retrieval": "hybrid",
    "X-Rangabot-Memory": "used",
    "X-Rangabot-Memory-Titles": encodeURIComponent(JSON.stringify(["Preferred learning style"])),
    "X-Rangabot-Finish": encodeURIComponent(JSON.stringify({ version: "finish-v1", status: "passed", checks: ["completion", "requirements"], issueCount: 0 })),
    "X-Rangabot-Capability": encodeURIComponent(JSON.stringify({ version: "capability-route-v1", status: "selected", route: "conversation", contexts: ["approved-memory"], reasons: ["ordinary-conversation"] })),
  });
  const wrapped = wrapSuccessfulTurnResponse(response, databaseCallbacks(turnId));

  assert.equal(await wrapped.text(), "A useful completed answer.");
  const turn = turns.getConversationTurn(turnId);
  const canonical = conversations.getConversation(conversation.id)?.messages ?? [];
  assert.equal(turn?.status, "completed");
  assert.equal(turn?.assistantMessage?.knowledgeUsed, true);
  assert.equal(turn?.assistantMessage?.retrievalMode, "hybrid");
  assert.equal(turn?.assistantMessage?.memoryUse, "context");
  assert.deepEqual(turn?.assistantMessage?.memoryTitles, ["Preferred learning style"]);
  assert.deepEqual(turn?.assistantMessage?.finishVerification, { version: "finish-v1", status: "passed", checks: ["completion", "requirements"], issueCount: 0 });
  assert.deepEqual(turn?.assistantMessage?.capabilityReceipt, { version: "capability-route-v1", status: "selected", route: "conversation", contexts: ["approved-memory"], reasons: ["ordinary-conversation"] });
  assert.deepEqual(canonical.map((message) => message.content), ["Teach me one useful fact.", "A useful completed answer."]);
});

test("consumer cancellation stores a partial as cancelled but never as canonical history", async () => {
  const { conversation, turnId } = startTurn("Stop this answer midway.");
  const encoder = new TextEncoder();
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("Provisional words"));
    },
  }), { headers: { "X-Rangabot-Finish": encodeURIComponent(JSON.stringify({ version: "finish-v1", status: "passed", checks: ["completion", "requirements"], issueCount: 0 })) } });
  const wrapped = wrapSuccessfulTurnResponse(response, databaseCallbacks(turnId));
  assert.ok(wrapped.body);
  const reader = wrapped.body.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), "Provisional words");
  await reader.cancel(new DOMException("Stopped", "AbortError"));

  const turn = turns.getConversationTurn(turnId);
  assert.equal(turn?.status, "cancelled");
  assert.equal(turn?.assistantMessage?.content, "Provisional words");
  assert.equal(turn?.assistantMessage?.finishVerification, undefined);
  assert.deepEqual(conversations.getConversation(conversation.id)?.messages, []);
});

test("an absolute deadline records timeout rather than user cancellation", async () => {
  const { conversation, turnId } = startTurn("Bound this slow answer.");
  const encoder = new TextEncoder();
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode("Slow partial")); },
  }));
  const timeout = new AbortController();
  const wrapped = wrapSuccessfulTurnResponse(response, databaseCallbacks(turnId), timeout.signal);
  assert.ok(wrapped.body);
  const reader = wrapped.body.getReader();
  await reader.read();
  timeout.abort(new DOMException("Timed out", "TimeoutError"));
  await assert.rejects(reader.read());
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));
  assert.equal(turns.getConversationTurn(turnId)?.status, "failed");
  assert.equal(turns.getConversationTurn(turnId)?.failureCode, "timeout");
  assert.deepEqual(conversations.getConversation(conversation.id)?.messages, []);
});

test("cancellation exposes uncommitted artifact metadata even before the first body byte", async () => {
  let cancelled: ChatMessage | null = null;
  const callbacks: TurnLifecycleCallbacks = {
    complete: () => { assert.fail("an empty artifact response must not complete"); },
    cancel: (partial) => { cancelled = partial; },
    fail: () => { assert.fail("user cancellation must not be recorded as failure"); },
  };
  const artifact = { id: randomUUID(), title: "Draft", filename: "draft.docx", previewPages: 1 };
  const response = new Response(new ReadableStream<Uint8Array>({ start() {} }), {
    headers: { "X-Rangabot-Word-Artifact": encodeURIComponent(JSON.stringify(artifact)) },
  });
  const controller = new AbortController();
  const wrapped = wrapSuccessfulTurnResponse(response, callbacks, controller.signal);
  controller.abort(new DOMException("Stopped", "AbortError"));
  await assert.rejects(wrapped.text());
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));
  const receipt = cancelled as ChatMessage | null;
  assert.ok(receipt);
  assert.deepEqual(receipt.wordArtifact, artifact);
  assert.equal(receipt.content, "");
});

test("a before-byte Word cancellation keeps its receipt after artifact cleanup", async () => {
  let cancelled: ChatMessage | null = null;
  const artifact = { id: randomUUID(), title: "Draft", filename: "draft.docx", previewPages: 1 };
  const capabilityReceipt = {
    version: "capability-route-v1" as const,
    status: "selected" as const,
    route: "word-document" as const,
    contexts: [] as const,
    attemptedContexts: [] as const,
    reasons: ["explicit-word-artifact"] as const,
  };
  const response = new Response(new ReadableStream<Uint8Array>({ start() {} }), {
    headers: {
      "X-Rangabot-Word-Artifact": encodeURIComponent(JSON.stringify(artifact)),
      "X-Rangabot-Capability": encodeURIComponent(JSON.stringify(capabilityReceipt)),
    },
  });
  const controller = new AbortController();
  const wrapped = wrapSuccessfulTurnResponse(response, {
    complete: () => { assert.fail("a cancelled artifact response must not complete"); },
    cancel: (partial) => {
      if (!partial) { cancelled = null; return; }
      const { wordArtifact: _artifact, ...afterCleanup } = partial;
      cancelled = afterCleanup;
    },
    fail: () => { assert.fail("user cancellation must not be recorded as failure"); },
  }, controller.signal);
  controller.abort(new DOMException("Stopped", "AbortError"));
  await assert.rejects(wrapped.text());
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));
  assert.deepEqual(cancelled, { role: "assistant", content: "Generation was stopped.", capabilityReceipt });
});

test("a provider stream failure records its partial only on the failed turn", async () => {
  const { conversation, turnId } = startTurn("Handle a broken stream safely.");
  const encoder = new TextEncoder();
  let step = 0;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (step === 0) controller.enqueue(encoder.encode("Unverified partial"));
      else controller.error(new ProviderError("invalid-stream", "Malformed stream."));
      step += 1;
    },
  }));
  const wrapped = wrapSuccessfulTurnResponse(response, databaseCallbacks(turnId));
  assert.ok(wrapped.body);
  const reader = wrapped.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "Unverified partial");
  await assert.rejects(reader.read(), (error: unknown) => error instanceof ProviderError && error.code === "invalid-stream");

  const turn = turns.getConversationTurn(turnId);
  assert.equal(turn?.status, "failed");
  assert.equal(turn?.failureCode, "invalid-stream");
  assert.equal(turn?.assistantMessage?.content, "Unverified partial");
  assert.deepEqual(conversations.getConversation(conversation.id)?.messages, []);
});

test("a zero-byte stream failure durably preserves its capability attempt receipt", async () => {
  const { conversation, turnId } = startTurn("Analyze the attached data safely.");
  const receipt = { version: "capability-route-v1", status: "selected", route: "analytics", contexts: [], attemptedContexts: ["dataset"], reasons: ["attached-data-analysis"] };
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.error(new ProviderError("invalid-stream", "Malformed stream.")); },
  }), { headers: {
    "X-Rangabot-Capability": encodeURIComponent(JSON.stringify(receipt)),
    "X-Rangabot-Finish": encodeURIComponent(JSON.stringify({ version: "finish-v1", status: "passed", checks: ["completion", "requirements"], issueCount: 0 })),
  } });
  const wrapped = wrapSuccessfulTurnResponse(response, databaseCallbacks(turnId));
  await assert.rejects(wrapped.text(), (error: unknown) => error instanceof ProviderError && error.code === "invalid-stream");

  const turn = turns.getConversationTurn(turnId);
  assert.equal(turn?.status, "failed");
  assert.deepEqual(turn?.assistantMessage?.capabilityReceipt, receipt);
  assert.equal(turn?.assistantMessage?.finishVerification, undefined);
  assert.equal(turn?.assistantMessage?.content, "Malformed stream.");
  assert.deepEqual(conversations.getConversation(conversation.id)?.messages, []);
});

test("a zero-byte cancelled stream durably preserves its capability attempt receipt", async () => {
  const { conversation, turnId } = startTurn("Stop attached-data analysis before output.");
  const receipt = { version: "capability-route-v1", status: "selected", route: "analytics", contexts: [], attemptedContexts: ["dataset"], reasons: ["attached-data-analysis"] };
  const response = new Response(new ReadableStream<Uint8Array>({ start() {} }), {
    headers: {
      "X-Rangabot-Capability": encodeURIComponent(JSON.stringify(receipt)),
      "X-Rangabot-Finish": encodeURIComponent(JSON.stringify({ version: "finish-v1", status: "passed", checks: ["completion", "requirements"], issueCount: 0 })),
    },
  });
  const controller = new AbortController();
  const wrapped = wrapSuccessfulTurnResponse(response, databaseCallbacks(turnId), controller.signal);
  controller.abort(new DOMException("Stopped", "AbortError"));
  await assert.rejects(wrapped.text());
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));

  const turn = turns.getConversationTurn(turnId);
  assert.equal(turn?.status, "cancelled");
  assert.equal(turn?.assistantMessage?.content, "Generation was stopped.");
  assert.deepEqual(turn?.assistantMessage?.capabilityReceipt, receipt);
  assert.equal(turn?.assistantMessage?.finishVerification, undefined);
  assert.deepEqual(conversations.getConversation(conversation.id)?.messages, []);
});

test("an empty successful body becomes a typed failure and cannot complete the turn", async () => {
  const { conversation, turnId } = startTurn("Do not accept an empty answer.");
  const response = chunkedTextResponse([]);
  const wrapped = wrapSuccessfulTurnResponse(response, databaseCallbacks(turnId));
  await assert.rejects(wrapped.text(), (error: unknown) => error instanceof ProviderError && error.code === "empty-output");

  const turn = turns.getConversationTurn(turnId);
  assert.equal(turn?.status, "failed");
  assert.equal(turn?.failureCode, "empty-output");
  assert.deepEqual(conversations.getConversation(conversation.id)?.messages, []);
});

test("a completion persistence rollback is converted into a failed receipt", async () => {
  const { conversation, turnId } = startTurn("Do not show an unsaved answer as complete.");
  const database = conversations.getConversationDatabase();
  database.exec(`
    CREATE TRIGGER reject_stream_completion BEFORE UPDATE OF messages ON conversations
    BEGIN SELECT RAISE(ABORT, 'test persistence rollback'); END;
  `);
  const wrapped = wrapSuccessfulTurnResponse(chunkedTextResponse(["Generated but not safely saved."]), databaseCallbacks(turnId));
  await assert.rejects(wrapped.text(), /test persistence rollback/);
  database.exec("DROP TRIGGER reject_stream_completion");

  const turn = turns.getConversationTurn(turnId);
  assert.equal(turn?.status, "failed");
  assert.equal(turn?.failureCode, "internal");
  assert.deepEqual(conversations.getConversation(conversation.id)?.messages, []);
});

test("HTTP failures terminalize a turn without treating the error body as an answer", async () => {
  const { conversation, turnId } = startTurn("Surface provider unavailability.");
  const response = Response.json({ error: "The configured local model is unavailable.", code: "model-missing" }, { status: 503 });
  const returned = await recordFailedTurnResponse(response, databaseCallbacks(turnId));

  assert.equal(returned, response);
  const turn = turns.getConversationTurn(turnId);
  assert.equal(turn?.status, "failed");
  assert.equal(turn?.failureCode, "model-missing");
  assert.equal(turn?.failureMessage, "The configured local model is unavailable.");
  assert.equal(turn?.assistantMessage, null);
  assert.deepEqual(conversations.getConversation(conversation.id)?.messages, []);
});

test("a selected capability receipt survives a typed execution failure without entering canonical history", async () => {
  const { conversation, turnId } = startTurn("Analyze the attached data.");
  const receipt = { version: "capability-route-v1", status: "selected", route: "analytics", contexts: [], attemptedContexts: ["dataset"], reasons: ["attached-data-analysis"] };
  const response = Response.json({ error: "The local analysis engine was unavailable.", code: "unavailable" }, {
    status: 503,
    headers: { "X-Rangabot-Capability": encodeURIComponent(JSON.stringify(receipt)) },
  });
  await recordFailedTurnResponse(response, databaseCallbacks(turnId));

  const turn = turns.getConversationTurn(turnId);
  assert.equal(turn?.status, "failed");
  assert.deepEqual(turn?.assistantMessage?.capabilityReceipt, receipt);
  assert.match(turn?.assistantMessage?.content ?? "", /analysis engine was unavailable/i);
  assert.deepEqual(conversations.getConversation(conversation.id)?.messages, []);
});

test("persists a visible model response resource limit as its typed terminal failure", async () => {
  const { conversation, turnId } = startTurn("Keep oversized local output bounded.");
  const response = Response.json({
    error: "The local model response exceeded Rangabot's safe output limit.",
    code: "resource-limit",
  }, { status: 502 });
  await recordFailedTurnResponse(response, databaseCallbacks(turnId));

  const turn = turns.getConversationTurn(turnId);
  assert.equal(turn?.status, "failed");
  assert.equal(turn?.failureCode, "resource-limit");
  assert.match(turn?.failureMessage ?? "", /safe output limit/);
  assert.equal(turn?.assistantMessage, null);
  assert.deepEqual(conversations.getConversation(conversation.id)?.messages, []);
});

test("an aborted HTTP failure preserves the absolute deadline as a timeout", async () => {
  const { conversation, turnId } = startTurn("Preserve this deadline failure.");
  const timeout = new AbortController();
  timeout.abort(new DOMException("The local turn exceeded its time limit.", "TimeoutError"));
  const receipt = { version: "capability-route-v1", status: "selected", route: "analytics", contexts: [], attemptedContexts: ["dataset"], reasons: ["attached-data-analysis"] };
  const response = Response.json({ error: "Generation was stopped.", code: "cancelled" }, {
    status: 499,
    headers: { "X-Rangabot-Capability": encodeURIComponent(JSON.stringify(receipt)) },
  });

  const returned = await recordFailedTurnResponse(response, databaseCallbacks(turnId), timeout.signal);

  assert.equal(returned, response);
  const turn = turns.getConversationTurn(turnId);
  assert.equal(turn?.status, "failed");
  assert.equal(turn?.failureCode, "timeout");
  assert.equal(turn?.failureMessage, "The local model timed out.");
  assert.equal(turn?.assistantMessage?.content, "The local model timed out.");
  assert.deepEqual(turn?.assistantMessage?.capabilityReceipt, receipt);
  assert.deepEqual(conversations.getConversation(conversation.id)?.messages, []);
});

test("completed replay reproduces content and conversation metadata without generation", async () => {
  const answer: ChatMessage = {
    role: "assistant",
    content: "Stored answer.",
    knowledgeUsed: true,
    retrievalMode: "keyword-only",
    memoryUse: "direct",
    memoryTitles: ["Local nickname"],
    finishVerification: { version: "finish-v1", status: "repaired", checks: ["completion", "preservation"], issueCount: 0 },
    capabilityReceipt: { version: "capability-route-v1", status: "selected", route: "direct-memory", contexts: ["approved-memory"], reasons: ["explicit-memory-recall"] },
  };
  const response = responseFromCompletedAssistant(answer);

  assert.equal(await response.text(), "Stored answer.");
  assert.equal(response.headers.get("X-Rangabot-Turn-Replay"), "completed");
  assert.equal(response.headers.get("X-Rangabot-Knowledge"), "used");
  assert.equal(response.headers.get("X-Rangabot-Retrieval"), "keyword-only");
  assert.equal(response.headers.get("X-Rangabot-Memory"), "direct");
  assert.deepEqual(
    JSON.parse(decodeURIComponent(response.headers.get("X-Rangabot-Memory-Titles") ?? "")),
    ["Local nickname"],
  );
  assert.deepEqual(
    JSON.parse(decodeURIComponent(response.headers.get("X-Rangabot-Finish") ?? "")),
    answer.finishVerification,
  );
  assert.deepEqual(
    JSON.parse(decodeURIComponent(response.headers.get("X-Rangabot-Capability") ?? "")),
    answer.capabilityReceipt,
  );
});

test("completed replay preserves the exact expert warning provenance", async () => {
  const answer: ChatMessage = {
    role: "assistant",
    content: "Verified fallback.",
    analysisTrace: {
      engine: "duckdb", dataset: "fixture.csv", query: "SELECT 1", returnedRows: 1,
      truncated: false, durationMs: 1, inputSha256: "a".repeat(64), querySha256: "b".repeat(64),
      packId: "analytics", packVersion: "0.1.0", modelMode: "general", modelId: "local:3b",
    },
    answerDisposition: "verified-fallback",
    packWarnings: ["narration-grounding-rejected"],
  };
  const response = responseFromCompletedAssistant(answer);
  assert.equal(response.headers.get("X-Rangabot-Pack-Warnings"), "narration-grounding-rejected");
});

test("stream settlement invokes exactly one terminal callback", async () => {
  const events: string[] = [];
  const callbacks: TurnLifecycleCallbacks = {
    complete: () => { events.push("complete"); },
    cancel: () => { events.push("cancel"); },
    fail: () => { events.push("fail"); },
  };
  const encoder = new TextEncoder();
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode("partial")); },
  }));
  const wrapped = wrapSuccessfulTurnResponse(response, callbacks);
  assert.ok(wrapped.body);
  const reader = wrapped.body.getReader();
  await reader.read();
  await reader.cancel();
  await reader.cancel();
  assert.deepEqual(events, ["cancel"]);
});
