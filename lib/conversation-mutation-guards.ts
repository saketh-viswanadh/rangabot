import {
  getConversation,
  getConversationDatabase,
  setConversationDataset,
  setConversationProject,
  type Conversation,
} from "./conversations.ts";
import {
  ConversationArtifactReferenceError,
  deleteConversationRecordWithArtifacts,
  recoverArtifactDeletionQuarantine,
  stageOwnedWordArtifactDirectories,
  type ArtifactQuarantineRecovery,
  type ArtifactDirectoryStager,
  type StagedArtifactDeletion,
} from "./conversation-artifacts.ts";
import {
  conversationContextBinding,
  recoverExpiredConversationTurns,
  type ConversationContextBinding,
} from "./conversation-turns.ts";

export type GuardedDeleteResult = "deleted" | "deleted-cleanup-pending" | "not-found" | "turn-in-progress" | "artifact-cleanup-failed";
export type GuardedConversationBindingUpdate =
  | { kind: "updated"; conversation: Conversation }
  | { kind: "not-found" }
  | { kind: "stale-binding" }
  | { kind: "turn-in-progress" };

function sameConversationBinding(left: ConversationContextBinding, right: ConversationContextBinding) {
  return left.projectId === right.projectId
    && left.datasetId === right.datasetId
    && left.datasetSha256 === right.datasetSha256
    && left.contextMessageCount === right.contextMessageCount;
}

function updateConversationBindingWhenIdle(
  id: string,
  expectedBinding: ConversationContextBinding,
  mutate: () => boolean,
): GuardedConversationBindingUpdate {
  recoverExpiredConversationTurns();
  const database = getConversationDatabase();
  database.exec("BEGIN IMMEDIATE");
  try {
    const before = getConversation(id);
    if (!before) {
      database.exec("ROLLBACK");
      return { kind: "not-found" };
    }
    if (!sameConversationBinding(conversationContextBinding(before), expectedBinding)) {
      database.exec("ROLLBACK");
      return { kind: "stale-binding" };
    }
    const pending = database.prepare(`
      SELECT 1 FROM conversation_turns
      WHERE conversation_id = ? AND status = 'pending'
      LIMIT 1
    `).get(id);
    if (pending) {
      database.exec("ROLLBACK");
      return { kind: "turn-in-progress" };
    }
    if (!mutate()) {
      database.exec("ROLLBACK");
      return { kind: "not-found" };
    }
    const conversation = getConversation(id);
    if (!conversation) throw new Error("The updated conversation could not be read.");
    database.exec("COMMIT");
    return { kind: "updated", conversation };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function setConversationDatasetWhenIdle(
  id: string,
  datasetId: string | null,
  expectedBinding: ConversationContextBinding,
): GuardedConversationBindingUpdate {
  return updateConversationBindingWhenIdle(
    id,
    expectedBinding,
    () => Boolean(setConversationDataset(id, datasetId)),
  );
}

export function setConversationProjectWhenIdle(
  id: string,
  projectId: string | null,
  expectedBinding: ConversationContextBinding,
): GuardedConversationBindingUpdate {
  return updateConversationBindingWhenIdle(
    id,
    expectedBinding,
    () => Boolean(setConversationProject(id, projectId)),
  );
}

function guardedDelete(checkPending: () => boolean, mutate: () => boolean): GuardedDeleteResult {
  recoverExpiredConversationTurns();
  const database = getConversationDatabase();
  database.exec("BEGIN IMMEDIATE");
  try {
    if (checkPending()) {
      database.exec("ROLLBACK");
      return "turn-in-progress";
    }
    const deleted = mutate();
    database.exec("COMMIT");
    return deleted ? "deleted" : "not-found";
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function deleteConversationWhenIdle(
  id: string,
  options: {
    stageArtifactDirectories?: ArtifactDirectoryStager;
    recoverArtifactQuarantine?: ArtifactQuarantineRecovery;
  } = {},
): GuardedDeleteResult {
  recoverExpiredConversationTurns();
  const database = getConversationDatabase();
  database.exec("BEGIN IMMEDIATE");
  let stagedDeletion: StagedArtifactDeletion | undefined;
  try {
    const pending = database.prepare("SELECT 1 FROM conversation_turns WHERE conversation_id = ? AND status = 'pending' LIMIT 1").get(id);
    if (pending) {
      database.exec("ROLLBACK");
      return "turn-in-progress";
    }
    const result = deleteConversationRecordWithArtifacts(
      database,
      id,
      options.stageArtifactDirectories ?? stageOwnedWordArtifactDirectories,
    );
    if (result.kind === "artifact-cleanup-failed") {
      database.exec("ROLLBACK");
      return result.kind;
    }
    if (result.kind === "deleted") stagedDeletion = result.stagedDeletion;
    database.exec("COMMIT");
    if (!stagedDeletion || stagedDeletion.finalize()) return result.kind;
    try {
      (options.recoverArtifactQuarantine ?? recoverArtifactDeletionQuarantine)(database);
      return result.kind;
    } catch {
      return "deleted-cleanup-pending";
    }
  } catch (error) {
    try { database.exec("ROLLBACK"); }
    finally { stagedDeletion?.rollback(); }
    if (error instanceof ConversationArtifactReferenceError) return "artifact-cleanup-failed";
    throw error;
  }
}

export function deleteProjectWhenIdle(id: string): GuardedDeleteResult {
  const database = getConversationDatabase();
  return guardedDelete(
    () => Boolean(database.prepare(`
      SELECT 1 FROM conversation_turns turn
      JOIN conversations conversation ON conversation.id = turn.conversation_id
      WHERE conversation.project_id = ? AND turn.status = 'pending'
      LIMIT 1
    `).get(id)),
    () => {
      database.prepare("UPDATE conversations SET project_id = NULL WHERE project_id = ?").run(id);
      return database.prepare("DELETE FROM projects WHERE id = ?").run(id).changes > 0;
    },
  );
}
