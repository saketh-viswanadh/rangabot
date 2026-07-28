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
  const created = conversations.createConversation([{ role: "user", content: "Plan a tiny local app" }]);
  assert.equal(created.title, "Plan a tiny local app");
  assert.equal(conversations.listConversations()[0]?.id, created.id);

  const updated = conversations.updateConversation(created.id, [
    { role: "user", content: "Plan a tiny local app" },
    { role: "assistant", content: "Start with one local route." },
  ]);
  assert.equal(updated?.messages.length, 2);
  assert.equal(conversations.getConversation(created.id)?.messages[1]?.role, "assistant");

  assert.equal(conversations.deleteConversation(created.id), true);
  assert.equal(conversations.getConversation(created.id), null);
});
