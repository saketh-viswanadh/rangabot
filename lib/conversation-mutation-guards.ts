import { getConversationDatabase } from "./conversations.ts";
import {
  ConversationArtifactReferenceError,
  deleteConversationRecordWithArtifacts,
  recoverArtifactDeletionQuarantine,
  stageOwnedWordArtifactDirectories,
  type ArtifactQuarantineRecovery,
  type ArtifactDirectoryStager,
  type StagedArtifactDeletion,
} from "./conversation-artifacts.ts";
import { recoverExpiredConversationTurns } from "./conversation-turns.ts";

export type GuardedDeleteResult = "deleted" | "deleted-cleanup-pending" | "not-found" | "turn-in-progress" | "artifact-cleanup-failed";

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
