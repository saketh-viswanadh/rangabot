import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const conversationRoute = readFileSync("app/api/conversations/[id]/route.ts", "utf8");
const projectRoute = readFileSync("app/api/projects/[id]/route.ts", "utf8");

test("dataset binding changes are serialized against pending lifecycle turns", () => {
  assert.match(conversationRoute, /recoverExpiredConversationTurns\(\)/);
  assert.match(conversationRoute, /BEGIN IMMEDIATE/);
  assert.match(
    conversationRoute,
    /SELECT 1 FROM conversation_turns[\s\S]*conversation_id = \?[\s\S]*status = 'pending'/,
  );
  assert.match(conversationRoute, /setConversationDatasetWhenIdle\(id, body\.datasetId as string \| null\)/);
  assert.match(conversationRoute, /code: "turn-in-progress"[\s\S]*status: 409/);
});

test("non-binding pin changes remain available while a turn is active", () => {
  const datasetBranch = conversationRoute.indexOf('hasOwnProperty.call(body, "datasetId")');
  const pinBranch = conversationRoute.indexOf('typeof body.pinned !== "boolean"');

  assert.notEqual(datasetBranch, -1);
  assert.notEqual(pinBranch, -1);
  assert.equal(datasetBranch < pinBranch, true);
  assert.match(conversationRoute.slice(pinBranch), /setConversationPinned\(id, body\.pinned\)/);
});

test("destructive conversation and project mutations use pending-turn guards", () => {
  assert.match(conversationRoute, /deleteConversationWhenIdle\(\(await context\.params\)\.id\)/);
  assert.match(conversationRoute, /Stop or finish the active turn before deleting this conversation/);
  assert.match(projectRoute, /deleteProjectWhenIdle\(\(await context\.params\)\.id\)/);
  assert.match(projectRoute, /Stop or finish active turns before deleting this project/);
});
