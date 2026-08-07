import { getConversationDatabase } from "./conversations.ts";
import { recoverExpiredConversationTurns } from "./conversation-turns.ts";

export type GuardedDeleteResult = "deleted" | "not-found" | "turn-in-progress";

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

export function deleteConversationWhenIdle(id: string): GuardedDeleteResult {
  const database = getConversationDatabase();
  return guardedDelete(
    () => Boolean(database.prepare("SELECT 1 FROM conversation_turns WHERE conversation_id = ? AND status = 'pending' LIMIT 1").get(id)),
    () => database.prepare("DELETE FROM conversations WHERE id = ?").run(id).changes > 0,
  );
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
