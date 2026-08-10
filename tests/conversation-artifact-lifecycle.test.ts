import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import type { ChatMessage } from "../lib/providers/types.ts";
import {
  recoverArtifactDeletionQuarantine,
  stageOwnedWordArtifactDirectories,
  type ArtifactDirectoryStager,
} from "../lib/conversation-artifacts.ts";

const testDatabase = resolve("data/conversation-artifact-lifecycle-test.db");
for (const suffix of ["", "-shm", "-wal"]) rmSync(`${testDatabase}${suffix}`, { force: true });

const conversations = await import("../lib/conversations.ts");
const guards = await import("../lib/conversation-mutation-guards.ts");
const turns = await import("../lib/conversation-turns.ts");
conversations.setConversationDatabasePathForTests(testDatabase);

test.after(() => {
  conversations.closeConversationDatabaseForTests();
  for (const suffix of ["", "-shm", "-wal"]) rmSync(`${testDatabase}${suffix}`, { force: true });
});

function artifactMessage(id: string, title = "Synthetic document"): ChatMessage {
  return {
    role: "assistant",
    content: `Created ${title}.`,
    wordArtifact: { id, title, filename: "synthetic.docx", previewPages: 1 },
  };
}

function recordingStager(removed: string[], fail = false): ArtifactDirectoryStager {
  return (ids) => {
    if (fail) throw new Error("Synthetic permission denial");
    removed.push(...ids);
    return { processedArtifactIds: ids, finalize: () => true, rollback: () => undefined };
  };
}

test("deleting a conversation removes only artifacts not referenced by another conversation", () => {
  const sharedArtifactId = randomUUID();
  const exclusiveArtifactId = randomUUID();
  const owner = conversations.createConversation([
    { role: "user", content: "Keep the shared document." },
    artifactMessage(sharedArtifactId, "Shared document"),
  ]);
  const target = conversations.createConversation([
    { role: "user", content: "Delete this conversation." },
    artifactMessage(sharedArtifactId, "Shared document"),
    artifactMessage(exclusiveArtifactId, "Exclusive document"),
  ]);
  const removed: string[] = [];

  assert.equal(guards.deleteConversationWhenIdle(target.id, {
    stageArtifactDirectories: recordingStager(removed),
  }), "deleted");
  assert.deepEqual(removed, [exclusiveArtifactId]);
  assert.ok(conversations.getConversation(owner.id));
  assert.equal(conversations.getConversation(target.id), null);

  assert.equal(guards.deleteConversationWhenIdle(owner.id, { stageArtifactDirectories: recordingStager([]) }), "deleted");
});

test("turn receipts remain discoverable artifact ownership when canonical history has no reference", () => {
  const artifactId = randomUUID();
  const conversation = conversations.createConversation([]);
  const turnId = randomUUID();
  turns.beginConversationTurn({
    id: turnId,
    conversationId: conversation.id,
    userMessage: { role: "user", content: "Create then fail before committing this document." },
    options: { mode: "smart" },
  });
  assert.equal(turns.claimConversationTurn(conversation.id, turnId).kind, "claimed");
  turns.failConversationTurn(turnId, "internal", "Synthetic failure.", artifactMessage(artifactId));
  assert.deepEqual(conversations.getConversation(conversation.id)?.messages, []);
  const removed: string[] = [];

  assert.equal(guards.deleteConversationWhenIdle(conversation.id, {
    stageArtifactDirectories: recordingStager(removed),
  }), "deleted");
  assert.deepEqual(removed, [artifactId]);
});

test("artifact deletion failure keeps the conversation and permits a later retry", () => {
  const artifactId = randomUUID();
  const conversation = conversations.createConversation([
    { role: "user", content: "Delete this conversation safely." },
    artifactMessage(artifactId),
  ]);
  let failedAttempts = 0;

  assert.equal(guards.deleteConversationWhenIdle(conversation.id, {
    stageArtifactDirectories: (ids) => {
      failedAttempts += 1;
      return recordingStager([], true)(ids);
    },
  }), "artifact-cleanup-failed");
  assert.equal(failedAttempts, 1);
  assert.ok(conversations.getConversation(conversation.id));

  assert.equal(guards.deleteConversationWhenIdle(conversation.id, {
    stageArtifactDirectories: recordingStager([]),
  }), "deleted");
  assert.equal(conversations.getConversation(conversation.id), null);
});

test("artifact batches rollback before commit and purge only after commit", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rangabot-artifact-stage-"));
  const artifactId = randomUUID();
  const directory = resolve(root, artifactId);
  mkdirSync(directory);
  writeFileSync(resolve(directory, "synthetic.docx"), "private fixture");

  const stagedRollback = stageOwnedWordArtifactDirectories([artifactId], root);
  assert.equal(existsSync(directory), false);
  stagedRollback.rollback();
  assert.equal(existsSync(resolve(directory, "synthetic.docx")), true);

  const stagedCommit = stageOwnedWordArtifactDirectories([artifactId], root);
  assert.equal(stagedCommit.finalize(), true);
  assert.equal(existsSync(directory), false);
  rmSync(root, { recursive: true, force: true });
});

test("startup recovery restores a pending artifact when its conversation still exists", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rangabot-artifact-recover-live-"));
  const artifactId = randomUUID();
  const directory = resolve(root, artifactId);
  mkdirSync(directory);
  writeFileSync(resolve(directory, "synthetic.docx"), "private fixture");
  const conversation = conversations.createConversation([
    { role: "user", content: "Keep this conversation after a simulated crash." },
    artifactMessage(artifactId),
  ]);

  stageOwnedWordArtifactDirectories([artifactId], root);
  assert.equal(existsSync(directory), false);
  const recovery = recoverArtifactDeletionQuarantine(conversations.getConversationDatabase(), root);
  assert.deepEqual(recovery, { purgedBatches: 1, purgedArtifacts: 0, restoredArtifacts: 1 });
  assert.equal(existsSync(resolve(directory, "synthetic.docx")), true);

  assert.equal(guards.deleteConversationWhenIdle(conversation.id, { stageArtifactDirectories: recordingStager([]) }), "deleted");
  rmSync(root, { recursive: true, force: true });
});

test("startup recovery purges a pending artifact only after its conversation commit is gone", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rangabot-artifact-recover-deleted-"));
  const artifactId = randomUUID();
  const directory = resolve(root, artifactId);
  mkdirSync(directory);
  writeFileSync(resolve(directory, "synthetic.docx"), "private fixture");
  const conversation = conversations.createConversation([
    { role: "user", content: "Delete this conversation before recovery." },
    artifactMessage(artifactId),
  ]);

  stageOwnedWordArtifactDirectories([artifactId], root);
  conversations.getConversationDatabase().prepare("DELETE FROM conversations WHERE id = ?").run(conversation.id);
  const recovery = recoverArtifactDeletionQuarantine(conversations.getConversationDatabase(), root);
  assert.deepEqual(recovery, { purgedBatches: 1, purgedArtifacts: 1, restoredArtifacts: 0 });
  assert.equal(existsSync(directory), false);
  rmSync(root, { recursive: true, force: true });
});

test("a post-commit cleanup failure is visible instead of reporting full deletion", () => {
  const artifactId = randomUUID();
  const conversation = conversations.createConversation([
    { role: "user", content: "Delete the row but report delayed cleanup honestly." },
    artifactMessage(artifactId),
  ]);

  const result = guards.deleteConversationWhenIdle(conversation.id, {
    stageArtifactDirectories: (ids) => ({
      processedArtifactIds: ids,
      finalize: () => false,
      rollback: () => { throw new Error("Rollback must not run after commit."); },
    }),
    recoverArtifactQuarantine: () => { throw new Error("Synthetic cleanup retry failure."); },
  });
  assert.equal(result, "deleted-cleanup-pending");
  assert.equal(conversations.getConversation(conversation.id), null);
});

test("a database rollback restores every staged artifact", () => {
  const artifactId = randomUUID();
  const conversation = conversations.createConversation([
    { role: "user", content: "Keep this if database deletion fails." },
    artifactMessage(artifactId),
  ]);
  const database = conversations.getConversationDatabase();
  database.exec(`
    CREATE TRIGGER synthetic_block_delete
    BEFORE DELETE ON conversations
    WHEN OLD.id = '${conversation.id}'
    BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END;
  `);
  let rollbacks = 0;
  let finalizations = 0;
  assert.throws(() => guards.deleteConversationWhenIdle(conversation.id, {
    stageArtifactDirectories: (ids) => ({
      processedArtifactIds: ids,
      finalize: () => { finalizations += 1; return true; },
      rollback: () => { rollbacks += 1; },
    }),
  }), /synthetic rollback/);
  database.exec("DROP TRIGGER synthetic_block_delete");
  assert.equal(rollbacks, 1);
  assert.equal(finalizations, 0);
  assert.ok(conversations.getConversation(conversation.id));
  assert.equal(guards.deleteConversationWhenIdle(conversation.id, { stageArtifactDirectories: recordingStager([]) }), "deleted");
});
