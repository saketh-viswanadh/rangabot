import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const testDatabase = resolve("data/conversations-test.db");
const conversations = await import("../lib/conversations.ts");
conversations.setConversationDatabasePathForTests(testDatabase);

test.after(() => {
  conversations.closeConversationDatabaseForTests();
  for (const suffix of ["", "-shm", "-wal"]) rmSync(`${testDatabase}${suffix}`, { force: true });
});

test("creates, lists, updates, opens, and deletes a local conversation", () => {
  const project = conversations.createProject("Tiny app");
  const created = conversations.createConversation([{ role: "user", content: "Plan a tiny local app" }], project.id);
  assert.equal(created.title, "Plan a tiny local app");
  assert.equal(created.projectId, project.id);
  assert.equal(created.datasetId, null);
  assert.equal(conversations.listProjects()[0]?.name, "Tiny app");
  assert.equal(conversations.listConversations()[0]?.id, created.id);
  assert.equal(created.pinned, false);

  const updated = conversations.updateConversation(created.id, [
    { role: "user", content: "Plan a tiny local app" },
    { role: "assistant", content: "Start with one local route.", analysisTrace: { engine: "duckdb", dataset: "fixture.duckdb", query: "SELECT 1", returnedRows: 1, truncated: false, durationMs: 1, inputSha256: "a".repeat(64), querySha256: "b".repeat(64), packId: "analytics", packVersion: "0.1.0", modelMode: "general", modelId: "local:3b" }, answerDisposition: "verified-fallback" },
  ]);
  assert.equal(updated?.messages.length, 2);
  assert.equal(conversations.getConversation(created.id)?.messages[1]?.role, "assistant");
  assert.equal(conversations.getConversation(created.id)?.messages[1]?.answerDisposition, "verified-fallback");
  assert.equal(conversations.setConversationDataset(created.id, "approved-dataset")?.datasetId, "approved-dataset");
  assert.equal(conversations.getConversation(created.id)?.datasetId, "approved-dataset");
  assert.equal(conversations.setConversationDataset(created.id, null)?.datasetId, null);
  const researchProject = conversations.createProject("Research");
  assert.equal(conversations.setConversationProject(created.id, researchProject.id)?.projectId, researchProject.id);
  assert.equal(conversations.setConversationProject(created.id, null)?.projectId, null);
  assert.equal(conversations.setConversationProject(created.id, "missing-project"), null);
  assert.equal(conversations.setConversationProject(created.id, project.id)?.projectId, project.id);

  const other = conversations.createConversation([
    { role: "user", content: "Discuss a garden" },
    { role: "assistant", content: "A private vector database can help." },
  ]);
  assert.equal(conversations.listConversations({ query: "VECTOR DATABASE" })[0]?.id, other.id);
  assert.equal(conversations.listConversations({ query: "tiny local", projectId: project.id })[0]?.id, created.id);
  assert.equal(conversations.listConversations({ query: "garden", projectId: project.id }).length, 0);
  assert.equal(conversations.setConversationPinned(created.id, true)?.pinned, true);
  assert.equal(conversations.listConversations()[0]?.id, created.id);

  assert.equal(conversations.updateProject(project.id, "Tiny local app")?.name, "Tiny local app");
  assert.equal(conversations.deleteProject(project.id), true);
  assert.equal(conversations.getConversation(created.id)?.projectId, null);

  assert.equal(conversations.deleteConversation(created.id), true);
  assert.equal(conversations.deleteConversation(other.id), true);
  assert.equal(conversations.getConversation(created.id), null);
});
