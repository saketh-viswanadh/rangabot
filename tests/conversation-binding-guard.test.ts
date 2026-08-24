import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const conversationRoute = readFileSync("app/api/conversations/[id]/route.ts", "utf8");
const mutationGuards = readFileSync("lib/conversation-mutation-guards.ts", "utf8");
const projectRoute = readFileSync("app/api/projects/[id]/route.ts", "utf8");
const chatPage = readFileSync("app/page.tsx", "utf8");

test("dataset binding changes are serialized against pending lifecycle turns", () => {
  assert.match(mutationGuards, /recoverExpiredConversationTurns\(\)/);
  assert.match(mutationGuards, /BEGIN IMMEDIATE/);
  assert.match(
    mutationGuards,
    /SELECT 1 FROM conversation_turns[\s\S]*conversation_id = \?[\s\S]*status = 'pending'/,
  );
  assert.match(conversationRoute, /setConversationDatasetWhenIdle\(id, body\.datasetId as string \| null, body\.expectedConversationBinding as ConversationContextBinding\)/);
  assert.match(conversationRoute, /code: "turn-in-progress"[\s\S]*status: 409/);
});

test("project and dataset binding mutations compare the exact client receipt inside their write transaction", () => {
  const guardedUpdate = mutationGuards.slice(
    mutationGuards.indexOf("function updateConversationBindingWhenIdle"),
    mutationGuards.indexOf("export function setConversationDatasetWhenIdle"),
  );
  assert.ok(guardedUpdate.indexOf('database.exec("BEGIN IMMEDIATE")') < guardedUpdate.indexOf("conversationContextBinding(before)"));
  assert.ok(guardedUpdate.indexOf("conversationContextBinding(before)") < guardedUpdate.indexOf("mutate()"));
  assert.match(guardedUpdate, /return \{ kind: "stale-binding" \}/);
  assert.match(conversationRoute, /isValidConversationContextBinding\(body\.expectedConversationBinding\)/);
  assert.match(conversationRoute, /code: "stale-binding"[\s\S]*status: 409/);
});

test("non-binding pin changes remain available while a turn is active", () => {
  const datasetBranch = conversationRoute.indexOf('hasOwnProperty.call(body, "datasetId")');
  const pinBranch = conversationRoute.indexOf('typeof body.pinned !== "boolean"');

  assert.notEqual(datasetBranch, -1);
  assert.notEqual(pinBranch, -1);
  assert.equal(datasetBranch < pinBranch, true);
  assert.match(conversationRoute.slice(pinBranch), /setConversationPinned\(id, body\.pinned\)/);
});

test("conversation binding receipts use canonical completed history, never projected terminal timeline messages", () => {
  const getBranch = conversationRoute.slice(
    conversationRoute.indexOf("export async function GET"),
    conversationRoute.indexOf("export async function DELETE"),
  );
  assert.match(getBranch, /const canonicalConversation = getConversation\(id\)/);
  assert.match(getBranch, /getConversationTimeline\(id\)/);
  assert.match(getBranch, /conversationContextBinding\(canonicalConversation\)/);
  assert.doesNotMatch(getBranch, /conversationContextBinding\(conversation\)/);

  const patchBranch = conversationRoute.slice(conversationRoute.indexOf("export async function PATCH"));
  assert.match(patchBranch, /const canonicalConversation = getConversation\(id\)/);
  assert.doesNotMatch(patchBranch, /conversationContextBinding\(update\.conversation\)|conversationContextBinding\(conversation\)/);
});

test("a revoked stored dataset is exposed only as an effective null conversation binding", () => {
  assert.match(conversationRoute, /conversationContextBinding/);
  assert.match(conversationRoute, /attachedDataset: dataset \?/);
  const turnLifecycle = readFileSync("lib/conversation-turns.ts", "utf8");
  const bindingHelper = turnLifecycle.slice(
    turnLifecycle.indexOf("export function conversationContextBinding"),
    turnLifecycle.indexOf("export type ConversationTurnOptions"),
  );
  assert.match(bindingHelper, /datasetId: dataset \? conversation\.datasetId : null/);
  assert.match(bindingHelper, /datasetSha256: dataset\?\.fileIdentity\.sha256 \?\? null/);
});

test("destructive conversation and project mutations use pending-turn guards", () => {
  assert.match(conversationRoute, /deleteConversationWhenIdle\(\(await context\.params\)\.id\)/);
  assert.match(conversationRoute, /Stop or finish the active turn before deleting this conversation/);
  assert.match(conversationRoute, /result === "artifact-cleanup-failed"/);
  assert.match(conversationRoute, /code: "artifact-cleanup-failed"[\s\S]*retriable: true[\s\S]*status: 503/);
  assert.match(projectRoute, /deleteProjectWhenIdle\(\(await context\.params\)\.id\)/);
  assert.match(projectRoute, /Stop or finish active turns before deleting this project/);
});

test("artifact cleanup failures remain visible and retriable in the chat UI", () => {
  assert.match(chatPage, /setConversationTransferMessage\(typeof data\?\.error === "string"/);
  assert.match(chatPage, /Use the delete button to retry/);
});
