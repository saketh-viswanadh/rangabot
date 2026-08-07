import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const testDatabase = resolve("data/conversation-mutation-guards-test.db");
for (const suffix of ["", "-shm", "-wal"]) rmSync(`${testDatabase}${suffix}`, { force: true });

const conversations = await import("../lib/conversations.ts");
const turns = await import("../lib/conversation-turns.ts");
const guards = await import("../lib/conversation-mutation-guards.ts");
conversations.setConversationDatabasePathForTests(testDatabase);

test.after(() => {
  conversations.closeConversationDatabaseForTests();
  for (const suffix of ["", "-shm", "-wal"]) rmSync(`${testDatabase}${suffix}`, { force: true });
});

function beginPendingTurn(conversationId: string) {
  const id = randomUUID();
  turns.beginConversationTurn({
    id,
    conversationId,
    userMessage: { role: "user", content: "Keep this conversation available until the turn settles." },
    options: { mode: "smart" },
  });
  assert.equal(turns.claimConversationTurn(conversationId, id).kind, "claimed");
  return id;
}

test("conversation deletion is rejected while a turn is pending and succeeds after settlement", () => {
  const conversation = conversations.createConversation([]);
  const turnId = beginPendingTurn(conversation.id);

  assert.equal(guards.deleteConversationWhenIdle(conversation.id), "turn-in-progress");
  assert.ok(conversations.getConversation(conversation.id));
  assert.equal(turns.getConversationTurn(turnId)?.status, "pending");

  turns.cancelConversationTurn(turnId);
  assert.equal(guards.deleteConversationWhenIdle(conversation.id), "deleted");
  assert.equal(conversations.getConversation(conversation.id), null);
  assert.equal(guards.deleteConversationWhenIdle(conversation.id), "not-found");
});

test("project deletion never clears bindings while one of its conversations has a pending turn", () => {
  const project = conversations.createProject("Guarded project");
  const conversation = conversations.createConversation([], project.id);
  const turnId = beginPendingTurn(conversation.id);

  assert.equal(guards.deleteProjectWhenIdle(project.id), "turn-in-progress");
  assert.ok(conversations.listProjects().some((candidate) => candidate.id === project.id));
  assert.equal(conversations.getConversation(conversation.id)?.projectId, project.id);

  turns.cancelConversationTurn(turnId);
  assert.equal(guards.deleteProjectWhenIdle(project.id), "deleted");
  assert.equal(conversations.listProjects().some((candidate) => candidate.id === project.id), false);
  assert.equal(conversations.getConversation(conversation.id)?.projectId, null);
  assert.equal(guards.deleteProjectWhenIdle(project.id), "not-found");
});
