import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const testDatabase = resolve("data/conversation-mutation-guards-test.db");
const testDatasetRegistry = resolve("data/conversation-mutation-guards-datasets-test.json");
for (const suffix of ["", "-shm", "-wal"]) rmSync(`${testDatabase}${suffix}`, { force: true });
rmSync(testDatasetRegistry, { force: true });

const conversations = await import("../lib/conversations.ts");
const turns = await import("../lib/conversation-turns.ts");
const guards = await import("../lib/conversation-mutation-guards.ts");
const datasets = await import("../lib/datasets.ts");
conversations.setConversationDatabasePathForTests(testDatabase);
datasets.setDatasetRegistryPathForTests(testDatasetRegistry);

const datasetA = { id: "dataset-a", sha256: "a".repeat(64) };
const datasetB = { id: "dataset-b", sha256: "b".repeat(64) };
writeFileSync(testDatasetRegistry, JSON.stringify([datasetA, datasetB].map((dataset, index) => ({
  id: dataset.id,
  name: `${dataset.id}.csv`,
  path: resolve(`data/${dataset.id}.csv`),
  format: "csv",
  sizeBytes: 1,
  addedAt: "2026-01-01T00:00:00.000Z",
  approvalVersion: 2,
  fileIdentity: {
    device: "1",
    inode: String(index + 1),
    sizeBytes: 1,
    modifiedNs: "1",
    changedNs: "1",
    sha256: dataset.sha256,
  },
}))), { mode: 0o600 });

test.after(() => {
  conversations.closeConversationDatabaseForTests();
  datasets.resetDatasetRegistryPathForTests();
  for (const suffix of ["", "-shm", "-wal"]) rmSync(`${testDatabase}${suffix}`, { force: true });
  rmSync(testDatasetRegistry, { force: true });
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

test("stale project and dataset writers cannot overwrite a newer local-window binding", () => {
  const projectA = conversations.createProject("Window A project");
  const projectB = conversations.createProject("Window B project");
  const conversation = conversations.createConversation([], projectA.id, datasetA.id);
  const windowAReceipt = turns.conversationContextBinding(conversation);

  const projectUpdate = guards.setConversationProjectWhenIdle(conversation.id, projectB.id, windowAReceipt);
  assert.equal(projectUpdate.kind, "updated");
  if (projectUpdate.kind !== "updated") return;
  const afterProject = turns.conversationContextBinding(projectUpdate.conversation);
  const staleProjectUpdate = guards.setConversationProjectWhenIdle(conversation.id, null, windowAReceipt);
  assert.equal(staleProjectUpdate.kind, "stale-binding");
  assert.equal(conversations.getConversation(conversation.id)?.projectId, projectB.id);

  const datasetUpdate = guards.setConversationDatasetWhenIdle(conversation.id, datasetB.id, afterProject);
  assert.equal(datasetUpdate.kind, "updated");
  if (datasetUpdate.kind !== "updated") return;
  const staleDatasetCleanup = guards.setConversationDatasetWhenIdle(conversation.id, null, afterProject);
  assert.equal(staleDatasetCleanup.kind, "stale-binding");
  const finalConversation = conversations.getConversation(conversation.id);
  assert.ok(finalConversation);
  if (!finalConversation) return;
  assert.equal(finalConversation?.datasetId, datasetB.id);
  assert.equal(turns.conversationContextBinding(finalConversation).datasetSha256, datasetB.sha256);
});
