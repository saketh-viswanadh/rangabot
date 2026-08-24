import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ConversationTurnOptions } from "../lib/conversation-turns.ts";
import type { ChatMessage } from "../lib/providers/types.ts";

const testDatabase = resolve("data/conversation-turns-test.db");
const testDatasetRegistry = resolve("data/conversation-turns-datasets-test.json");
const testDatasetContextRegistry = resolve("data/conversation-turns-dataset-context-test.json");
const approvedDatasetId = "approved-local-fixture";
const approvedDatasetSha256 = "a".repeat(64);
for (const suffix of ["", "-shm", "-wal"]) rmSync(`${testDatabase}${suffix}`, { force: true });
rmSync(testDatasetRegistry, { force: true });
rmSync(testDatasetContextRegistry, { force: true });

// Start with the pre-lifecycle shape to prove the additive schema migration does
// not rewrite an existing transcript.
const legacyDatabase = new DatabaseSync(testDatabase);
legacyDatabase.exec(`
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    messages TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);
const legacyConversationId = randomUUID();
const legacyMessages: ChatMessage[] = [
  { role: "user", content: "Remember only completed history." },
  { role: "assistant", content: "Completed history remains canonical." },
];
legacyDatabase.prepare("INSERT INTO conversations (id, title, messages, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
  .run(legacyConversationId, "Legacy conversation", JSON.stringify(legacyMessages), "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
legacyDatabase.close();

const conversations = await import("../lib/conversations.ts");
const turns = await import("../lib/conversation-turns.ts");
const datasets = await import("../lib/datasets.ts");
const datasetContexts = await import("../lib/dataset-semantic-contexts.ts");
conversations.setConversationDatabasePathForTests(testDatabase);
datasets.setDatasetRegistryPathForTests(testDatasetRegistry);
datasetContexts.setDatasetSemanticContextRegistryPathForTests(testDatasetContextRegistry);

function writeApprovedDatasetFixture() {
  writeFileSync(testDatasetRegistry, JSON.stringify([{
    id: approvedDatasetId,
    name: "approved.csv",
    path: resolve("data/approved-local-fixture.csv"),
    format: "csv",
    sizeBytes: 1,
    addedAt: "2026-01-01T00:00:00.000Z",
    approvalVersion: 2,
    fileIdentity: {
      device: "1",
      inode: "1",
      sizeBytes: 1,
      modifiedNs: "1",
      changedNs: "1",
      sha256: approvedDatasetSha256,
    },
  }]), { mode: 0o600 });
}

test.after(() => {
  conversations.closeConversationDatabaseForTests();
  datasets.resetDatasetRegistryPathForTests();
  datasetContexts.resetDatasetSemanticContextRegistryPathForTests();
  for (const suffix of ["", "-shm", "-wal"]) rmSync(`${testDatabase}${suffix}`, { force: true });
  rmSync(testDatasetRegistry, { force: true });
  rmSync(testDatasetContextRegistry, { force: true });
});

function begin(
  conversationId: string,
  content: string,
  options: ConversationTurnOptions = { mode: "smart" },
  id = randomUUID(),
) {
  return turns.beginConversationTurn({
    id,
    conversationId,
    userMessage: { role: "user", content },
    options,
  });
}

function portable(messages: ChatMessage[]) {
  return messages.map(({ turn: _turn, ...message }) => message);
}

test("adds the lifecycle schema without rewriting a legacy transcript", () => {
  assert.deepEqual(conversations.getConversation(legacyConversationId)?.messages, legacyMessages);
  const tables = conversations.getConversationDatabase().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  assert.equal(tables.some((table) => table.name === "conversation_turns"), true);
  assert.deepEqual(conversations.getConversation(legacyConversationId)?.messages, legacyMessages);
});

test("begin is idempotent and one conversation permits only one pending turn", () => {
  const conversation = conversations.createConversation([]);
  const turnId = randomUUID();
  const first = begin(conversation.id, "Give one concise answer.", { mode: "local" }, turnId);
  const replay = begin(conversation.id, "Give one concise answer.", { mode: "local" }, turnId);

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.turn.id, turnId);
  assert.equal(turns.listConversationTurns(conversation.id).length, 1);
  assert.throws(
    () => begin(conversation.id, "Start another request."),
    (error: unknown) => error instanceof turns.ConversationTurnError && error.code === "turn-in-progress",
  );
  turns.cancelConversationTurn(turnId);
});

test("a turn id is bound to the complete normalized request, including mode and code context", () => {
  const conversation = conversations.createConversation([]);
  const turnId = randomUUID();
  begin(conversation.id, "Explain this function.", { mode: "local" }, turnId);

  assert.throws(
    () => begin(conversation.id, "Explain a different function.", { mode: "local" }, turnId),
    (error: unknown) => error instanceof turns.ConversationTurnError && error.code === "conflict",
  );
  assert.throws(
    () => begin(conversation.id, "Explain this function.", { mode: "teach" }, turnId),
    (error: unknown) => error instanceof turns.ConversationTurnError && error.code === "conflict",
  );
  assert.throws(
    () => begin(conversation.id, "Explain this function.", {
      mode: "local",
      codeContext: { repositoryId: "repo-a", path: "src/a.ts", line: 1 },
    }, turnId),
    (error: unknown) => error instanceof turns.ConversationTurnError && error.code === "conflict",
  );
  turns.cancelConversationTurn(turnId);
});

test("first-turn idempotency binds project and dataset creation context", () => {
  const projectA = conversations.createProject("Project A");
  const projectB = conversations.createProject("Project B");
  const turnId = randomUUID();
  const first = turns.beginConversationTurn({
    id: turnId,
    projectId: projectA.id,
    datasetId: null,
    userMessage: { role: "user", content: "Create this chat once." },
    options: { mode: "smart" },
  });
  assert.equal(first.turn.options.projectId, projectA.id);
  assert.throws(
    () => turns.beginConversationTurn({
      id: turnId,
      projectId: projectB.id,
      datasetId: null,
      userMessage: { role: "user", content: "Create this chat once." },
      options: { mode: "smart" },
    }),
    (error: unknown) => error instanceof turns.ConversationTurnError && error.code === "conflict",
  );
  conversations.deleteConversation(first.conversationId);
  conversations.deleteProject(projectA.id);
  conversations.deleteProject(projectB.id);
});

test("first-turn creation rejects a project deleted before atomic admission", () => {
  const project = conversations.createProject("Deleted before send");
  assert.equal(conversations.deleteProject(project.id), true);
  const turnId = randomUUID();
  const beforeCount = conversations.listConversations().length;
  assert.throws(
    () => turns.beginConversationTurn({
      id: turnId,
      projectId: project.id,
      datasetId: null,
      userMessage: { role: "user", content: "Do not create this chat in a deleted project." },
      options: { mode: "smart" },
    }),
    (error: unknown) => error instanceof turns.ConversationTurnError && error.code === "conflict",
  );
  assert.equal(turns.getConversationTurn(turnId), null);
  assert.equal(conversations.listConversations().length, beforeCount);
});

test("an existing-chat turn rejects a stale client-observed history binding before creation", () => {
  const conversation = conversations.createConversation(legacyMessages);
  const expectedConversationBinding = {
    projectId: conversation.projectId,
    datasetId: conversation.datasetId,
    datasetSha256: null,
    contextMessageCount: conversation.messages.length,
  };
  assert.throws(
    () => turns.beginConversationTurn({
      id: randomUUID(),
      conversationId: conversation.id,
      expectedConversationBinding: { ...expectedConversationBinding, contextMessageCount: legacyMessages.length - 1 },
      userMessage: { role: "user", content: "Do not use unseen history." },
      options: { mode: "smart" },
    }),
    (error: unknown) => error instanceof turns.ConversationTurnError && error.code === "conflict",
  );
  assert.equal(turns.listConversationTurns(conversation.id).length, 0);

  const accepted = turns.beginConversationTurn({
    id: randomUUID(),
    conversationId: conversation.id,
    expectedConversationBinding,
    userMessage: { role: "user", content: "Use only the history I reviewed." },
    options: { mode: "smart" },
  });
  assert.equal(accepted.turn.contextMessageCount, legacyMessages.length);
  turns.cancelConversationTurn(accepted.turn.id);
});

test("a recovered request is admitted only against the exact current conversation context", () => {
  const conversation = conversations.createConversation(legacyMessages, null, null);
  const failed = begin(conversation.id, "Original failed goal.", { mode: "smart" });
  turns.failConversationTurn(failed.turn.id, "timeout", "The original local request timed out.");
  const recoveryBinding = {
    sourceTurnId: failed.turn.id,
    conversationId: conversation.id,
    projectId: null,
    datasetId: null,
    datasetSha256: null,
    contextMessageCount: legacyMessages.length,
  };
  const accepted = begin(conversation.id, "Continue the recovered goal.", { mode: "smart", recoveryBinding });
  assert.equal(accepted.replayed, false);
  turns.cancelConversationTurn(accepted.turn.id);

  assert.throws(
    () => begin(conversation.id, "Reject a forged recovery origin.", {
      mode: "smart",
      recoveryBinding: { ...recoveryBinding, sourceTurnId: randomUUID() },
    }),
    (error: unknown) => error instanceof turns.ConversationTurnError && error.code === "conflict",
  );

  assert.throws(
    () => begin(conversation.id, "Do not attach stale context.", {
      mode: "smart",
      recoveryBinding: { ...recoveryBinding, contextMessageCount: legacyMessages.length + 2 },
    }),
    (error: unknown) => error instanceof turns.ConversationTurnError && error.code === "conflict",
  );
});

test("a pre-project-hash turn upgrades only when its saved conversation binding matches", () => {
  const legacyProject = conversations.createProject("Legacy project");
  const turnId = randomUUID();
  const input = {
    id: turnId,
    projectId: legacyProject.id,
    datasetId: null,
    userMessage: { role: "user" as const, content: "Recover this ambiguous start safely." },
    options: { mode: "smart" as const },
  };
  const started = turns.beginConversationTurn(input);
  const database = conversations.getConversationDatabase();
  const row = database.prepare("SELECT user_message AS userMessage, request_options AS requestOptions FROM conversation_turns WHERE id = ?")
    .get(turnId) as { userMessage: string; requestOptions: string };
  const oldOptions = JSON.parse(row.requestOptions) as Record<string, unknown>;
  delete oldOptions.projectId;
  const oldHash = createHash("sha256").update(JSON.stringify({ message: JSON.parse(row.userMessage), options: oldOptions })).digest("hex");
  database.prepare("UPDATE conversation_turns SET request_hash = ?, request_options = ? WHERE id = ?")
    .run(oldHash, JSON.stringify(oldOptions), turnId);

  assert.throws(
    () => turns.beginConversationTurn({ ...input, projectId: "different-project" }),
    (error: unknown) => error instanceof turns.ConversationTurnError && error.code === "conflict",
  );
  const replay = turns.beginConversationTurn(input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.turn.options.projectId, legacyProject.id);
  assert.notEqual(replay.turn.requestHash, oldHash);
  conversations.deleteConversation(started.conversationId);
  conversations.deleteProject(legacyProject.id);
});

test("claimed prompt context is bounded without losing the current request", () => {
  const history = Array.from({ length: 260 }, (_, index): ChatMessage => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `${index}:${"x".repeat(5_000)}`,
  }));
  const conversation = conversations.createConversation(history);
  const started = begin(conversation.id, "This current request must remain last.");
  const claim = turns.claimConversationTurn(conversation.id, started.turn.id);
  assert.equal(claim.kind, "claimed");
  if (claim.kind !== "claimed") return;
  assert.ok(claim.messages.length <= 200);
  assert.ok(claim.messages.reduce((total, message) => total + message.content.length, 0) <= 1_000_000);
  assert.equal(claim.messages.at(-1)?.content, "This current request must remain last.");
  assert.equal(claim.messages[0]?.role, "user");
  turns.cancelConversationTurn(started.turn.id);
});

test("reply context never pushes a prompt message over its per-message limit", () => {
  const messages = turns.buildBoundedPromptMessages([], {
    role: "user",
    content: "x".repeat(50_000),
    replyTo: { role: "assistant", excerpt: "y".repeat(500) },
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content.length, 50_000);
});

test("completion appends one atomic pair and completed replay never duplicates it", () => {
  const conversation = conversations.createConversation(legacyMessages);
  const turnId = randomUUID();
  const input = begin(conversation.id, "What comes next?", { mode: "smart" }, turnId);
  const claim = turns.claimConversationTurn(conversation.id, turnId);
  assert.equal(claim.kind, "claimed");
  if (claim.kind !== "claimed") return;
  assert.deepEqual(portable(claim.messages), [...legacyMessages, { role: "user", content: "What comes next?" }]);

  const answer: ChatMessage = {
    role: "assistant",
    content: "Only this completed answer joins canonical history.",
    retrievalMode: "hybrid",
    knowledgeUsed: true,
  };
  const completed = turns.completeConversationTurn(turnId, answer);
  const completedAgain = turns.completeConversationTurn(turnId, answer);
  const replay = turns.beginConversationTurn({
    id: turnId,
    conversationId: conversation.id,
    userMessage: input.turn.userMessage,
    options: { mode: "smart" },
  });
  const replayClaim = turns.claimConversationTurn(conversation.id, turnId);
  const canonical = conversations.getConversation(conversation.id)?.messages ?? [];

  assert.equal(completed.status, "completed");
  assert.equal(completedAgain.status, "completed");
  assert.equal(replay.replayed, true);
  assert.equal(replayClaim.kind, "completed");
  assert.equal(canonical.length, legacyMessages.length + 2);
  assert.deepEqual(portable(canonical), [...legacyMessages, { role: "user", content: "What comes next?" }, answer]);
  assert.equal(canonical.at(-1)?.retrievalMode, "hybrid");
  assert.throws(
    () => turns.completeConversationTurn(turnId, { role: "assistant", content: "A replacement answer." }),
    (error: unknown) => error instanceof turns.ConversationTurnError && error.code === "conflict",
  );
});

test("cancelled and failed turns remain inspectable but never enter canonical model history", () => {
  const conversation = conversations.createConversation(legacyMessages);
  const cancelledId = randomUUID();
  begin(conversation.id, "Question that gets cancelled.", { mode: "smart" }, cancelledId);
  assert.equal(turns.claimConversationTurn(conversation.id, cancelledId).kind, "claimed");
  turns.cancelConversationTurn(cancelledId, { role: "assistant", content: "Untrusted cancelled partial." });

  const failedId = randomUUID();
  begin(conversation.id, "Question that fails.", { mode: "smart" }, failedId);
  assert.equal(turns.claimConversationTurn(conversation.id, failedId).kind, "claimed");
  turns.failConversationTurn(failedId, "invalid-stream", "Malformed provider stream.", {
    role: "assistant",
    content: "Untrusted failed partial.",
  });

  assert.deepEqual(conversations.getConversation(conversation.id)?.messages, legacyMessages);
  assert.equal(turns.getConversationTurn(cancelledId)?.status, "cancelled");
  assert.equal(turns.getConversationTurn(failedId)?.status, "failed");

  const nextId = randomUUID();
  begin(conversation.id, "Use trustworthy context only.", { mode: "smart" }, nextId);
  const next = turns.claimConversationTurn(conversation.id, nextId);
  assert.equal(next.kind, "claimed");
  if (next.kind === "claimed") {
    const context = next.messages.map((message) => message.content).join("\n");
    assert.match(context, /Completed history remains canonical/);
    assert.match(context, /Use trustworthy context only/);
    assert.doesNotMatch(context, /Question that gets cancelled|Untrusted cancelled partial/);
    assert.doesNotMatch(context, /Question that fails|Untrusted failed partial|Malformed provider stream/);
  }
  turns.cancelConversationTurn(nextId);

  const timeline = turns.getConversationTimeline(conversation.id);
  assert.equal(timeline?.messages.some((message) => message.turn?.id === cancelledId && message.turn.status === "cancelled"), true);
  assert.equal(timeline?.messages.some((message) => message.turn?.id === failedId && message.turn.status === "failed"), true);
  assert.equal(conversations.listConversations({ query: "untrusted cancelled partial" }).length, 0);
  assert.equal(conversations.listConversations({ query: "untrusted failed partial" }).length, 0);
});

test("failed and cancelled reopen projections never change the canonical binding count", () => {
  const conversation = conversations.createConversation(legacyMessages);
  const expectedConversationBinding = {
    projectId: conversation.projectId,
    datasetId: conversation.datasetId,
    datasetSha256: null,
    contextMessageCount: conversation.messages.length,
  };
  const cancelled = turns.beginConversationTurn({
    id: randomUUID(),
    conversationId: conversation.id,
    expectedConversationBinding,
    userMessage: { role: "user", content: "Cancelled request must remain display-only." },
    options: { mode: "smart" },
  });
  turns.cancelConversationTurn(cancelled.turn.id, { role: "assistant", content: "Cancelled partial." });
  const failed = turns.beginConversationTurn({
    id: randomUUID(),
    conversationId: conversation.id,
    expectedConversationBinding,
    userMessage: { role: "user", content: "Failed request must remain display-only." },
    options: { mode: "smart" },
  });
  turns.failConversationTurn(failed.turn.id, "timeout", "Failed partial.", { role: "assistant", content: "Failed partial." });

  const reopened = turns.getConversationTimeline(conversation.id);
  const canonical = conversations.getConversation(conversation.id);
  assert.equal(reopened?.messages.length, legacyMessages.length + 4);
  assert.equal(reopened?.messages.some((message) => message.turn?.status === "cancelled"), true);
  assert.equal(reopened?.messages.some((message) => message.turn?.status === "failed"), true);
  assert.deepEqual(canonical?.messages, legacyMessages);
  assert.equal(canonical?.messages.length, cancelled.turn.contextMessageCount);
  assert.equal(canonical?.messages.length, failed.turn.contextMessageCount);
});

test("an explicit cancellation can be enriched by the server-observed stream partial", () => {
  const conversation = conversations.createConversation([]);
  const turnId = randomUUID();
  begin(conversation.id, "Stop after the first phrase.", { mode: "smart" }, turnId);
  turns.cancelConversationTurn(turnId);
  const enriched = turns.cancelConversationTurn(turnId, { role: "assistant", content: "Server-observed partial" });

  assert.equal(enriched.status, "cancelled");
  assert.equal(enriched.assistantMessage?.content, "Server-observed partial");
  assert.deepEqual(conversations.getConversation(conversation.id)?.messages, []);
});

test("competing terminal transitions preserve exactly one canonical outcome", async () => {
  const conversation = conversations.createConversation([]);
  const started = begin(conversation.id, "Race completion against cancellation.");
  turns.claimConversationTurn(conversation.id, started.turn.id);
  const outcomes = await Promise.allSettled([
    Promise.resolve().then(() => turns.completeConversationTurn(started.turn.id, { role: "assistant", content: "Committed answer." })),
    Promise.resolve().then(() => turns.cancelConversationTurn(started.turn.id)),
  ]);
  const turn = turns.getConversationTurn(started.turn.id);
  assert.ok(turn?.status === "completed" || turn?.status === "cancelled");
  const canonical = conversations.getConversation(conversation.id)?.messages ?? [];
  assert.equal(canonical.length, turn?.status === "completed" ? 2 : 0);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length <= 1, true);
});

test("first-turn creation is atomic and binds its private dataset snapshot", () => {
  writeApprovedDatasetFixture();
  const turnId = randomUUID();
  const started = turns.beginConversationTurn({
    id: turnId,
    projectId: null,
    datasetId: approvedDatasetId,
    userMessage: { role: "user", content: "Analyse the approved data." },
    options: { mode: "smart" },
  });

  assert.equal(started.turn.options.datasetId, approvedDatasetId);
  assert.equal(started.turn.options.datasetSha256, approvedDatasetSha256);
  assert.equal(conversations.getConversation(started.conversationId)?.messages.length, 0);
  assert.equal(conversations.getConversation(started.conversationId)?.datasetId, approvedDatasetId);
  assert.equal(conversations.deleteConversation(started.conversationId), true);
});

test("a revoked stored dataset reopens as an effective null binding and cannot enter a future turn", () => {
  writeApprovedDatasetFixture();
  const conversation = conversations.createConversation(legacyMessages, null, approvedDatasetId);
  const beforeRevoke = turns.conversationContextBinding(conversation);
  assert.equal(beforeRevoke.datasetId, approvedDatasetId);
  assert.equal(beforeRevoke.datasetSha256, approvedDatasetSha256);

  assert.equal(datasets.revokeDataset(approvedDatasetId), true);
  const canonical = conversations.getConversation(conversation.id);
  assert.equal(canonical?.datasetId, approvedDatasetId, "the stored row remains available for explicit reconciliation");
  assert.ok(canonical);
  if (!canonical) return;
  const reopenedBinding = turns.conversationContextBinding(canonical);
  assert.deepEqual(reopenedBinding, {
    projectId: null,
    datasetId: null,
    datasetSha256: null,
    contextMessageCount: legacyMessages.length,
  });

  assert.throws(
    () => turns.beginConversationTurn({
      id: randomUUID(),
      conversationId: conversation.id,
      expectedConversationBinding: beforeRevoke,
      userMessage: { role: "user", content: "Do not inherit the revoked dataset." },
      options: { mode: "smart" },
    }),
    (error: unknown) => error instanceof turns.ConversationTurnError && error.code === "conflict",
  );
  const started = turns.beginConversationTurn({
    id: randomUUID(),
    conversationId: conversation.id,
    expectedConversationBinding: reopenedBinding,
    userMessage: { role: "user", content: "Continue without the revoked dataset." },
    options: { mode: "smart" },
  });
  assert.equal(started.turn.options.datasetId, null);
  assert.equal(started.turn.options.datasetSha256, null);
  turns.cancelConversationTurn(started.turn.id);
});

test("a failed atomic completion leaves no canonical pair and can be terminalized", () => {
  const conversation = conversations.createConversation([]);
  const started = begin(conversation.id, "Prove completion rollback.");
  assert.equal(turns.claimConversationTurn(conversation.id, started.turn.id).kind, "claimed");
  const database = conversations.getConversationDatabase();
  database.exec(`
    CREATE TRIGGER reject_test_completion BEFORE UPDATE OF messages ON conversations
    BEGIN SELECT RAISE(ABORT, 'test rollback'); END;
  `);
  assert.throws(
    () => turns.completeConversationTurn(started.turn.id, { role: "assistant", content: "Must not persist." }),
    /test rollback/,
  );
  database.exec("DROP TRIGGER reject_test_completion");

  assert.equal(turns.getConversationTurn(started.turn.id)?.status, "pending");
  assert.deepEqual(conversations.getConversation(conversation.id)?.messages, []);
  assert.equal(turns.failConversationTurn(started.turn.id, "internal", "The answer could not be saved.").status, "failed");
});

test("stale pending work recovers as interrupted without polluting canonical history", () => {
  const conversation = conversations.createConversation(legacyMessages);
  const staleId = randomUUID();
  begin(conversation.id, "This request was abandoned.", { mode: "smart" }, staleId);
  conversations.getConversationDatabase().prepare(`
    UPDATE conversation_turns
    SET created_at = '2000-01-01T00:00:00.000Z', updated_at = '2000-01-01T00:00:00.000Z'
    WHERE id = ?
  `).run(staleId);

  assert.equal(turns.recoverExpiredConversationTurns(Date.now(), 1_000), 1);
  const recovered = turns.getConversationTurn(staleId);
  assert.equal(recovered?.status, "failed");
  assert.equal(recovered?.failureCode, "interrupted");
  assert.deepEqual(conversations.getConversation(conversation.id)?.messages, legacyMessages);

  const next = begin(conversation.id, "A fresh request can continue.");
  assert.equal(next.turn.status, "pending");
  turns.cancelConversationTurn(next.turn.id);
});

test("a live turn inside the maximum deadline is not reaped as stale", () => {
  const conversation = conversations.createConversation([]);
  const started = begin(conversation.id, "Allow a configured long local generation.");
  const twelveMinutesAgo = new Date(Date.now() - 12 * 60 * 1000).toISOString();
  conversations.getConversationDatabase().prepare(`
    UPDATE conversation_turns SET execution_started_at = ?, updated_at = ? WHERE id = ?
  `).run(twelveMinutesAgo, twelveMinutesAgo, started.turn.id);
  assert.equal(turns.recoverExpiredConversationTurns(), 0);
  assert.equal(turns.getConversationTurn(started.turn.id)?.status, "pending");
  turns.cancelConversationTurn(started.turn.id);
});

test("lifecycle ownership blocks whole-transcript replacement and deletion cascades turns", () => {
  const conversation = conversations.createConversation([]);
  const started = begin(conversation.id, "Create lifecycle ownership.");
  assert.throws(
    () => conversations.updateConversation(conversation.id, [{ role: "user", content: "Overwrite it." }]),
    /lifecycle-managed/,
  );
  assert.equal(turns.getConversationTurn(started.turn.id)?.conversationId, conversation.id);
  assert.equal(conversations.deleteConversation(conversation.id), true);
  assert.equal(turns.getConversationTurn(started.turn.id), null);
});
