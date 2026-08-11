import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "rangabot-response-feedback-"));
const databasePath = join(root, "rangabot.db");
const candidateBuildId = "a".repeat(64);
const conversations = await import("../lib/conversations.ts");
const turns = await import("../lib/conversation-turns.ts");
const feedback = await import("../lib/response-feedback.ts");
conversations.setConversationDatabasePathForTests(databasePath);

test.after(() => {
  conversations.closeConversationDatabaseForTests();
  rmSync(root, { recursive: true, force: true });
});

function completedResponse(candidate: string | null = candidateBuildId) {
  const conversation = conversations.createConversation([]);
  const turnId = randomUUID();
  turns.beginConversationTurn({
    id: turnId,
    conversationId: conversation.id,
    userMessage: { role: "user", content: "Give a local answer." },
    options: { mode: "smart" },
  });
  assert.equal(turns.claimConversationTurn(conversation.id, turnId).kind, "claimed");
  turns.completeConversationTurn(turnId, { role: "assistant", content: "This is the completed answer." }, candidate);
  return { conversation, turnId };
}

test("completed known-candidate responses create one minimal eligible row", () => {
  const { conversation, turnId } = completedResponse();
  const database = conversations.getConversationDatabase();
  const columns = database.prepare("PRAGMA table_info(response_feedback)").all() as Array<{ name: string }>;
  assert.deepEqual(columns.map((column) => column.name), [
    "turn_id", "rating", "candidate_build_id", "response_day_utc", "created_at", "updated_at",
  ]);
  const row = database.prepare(`
    SELECT turn_id AS turnId, rating, candidate_build_id AS candidateBuildId,
      response_day_utc AS responseDayUtc, created_at AS createdAt, updated_at AS updatedAt
    FROM response_feedback WHERE turn_id = ?
  `).get(turnId) as Record<string, unknown>;
  assert.equal(row.turnId, turnId);
  assert.equal(row.rating, null);
  assert.equal(row.candidateBuildId, candidateBuildId);
  assert.match(String(row.responseDayUtc), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(row.createdAt, row.updatedAt);
  assert.deepEqual(feedback.listConversationResponseFeedback(database, conversation.id), [{ turnId, rating: null }]);
  assert.equal(Object.keys(row).some((key) => /text|title|reason|memory|attachment|user|device|model/i.test(key)), false);
});

test("save, change, retry, and clear preserve one row and correct denominator math", () => {
  const aggregateCandidate = "b".repeat(64);
  const { conversation, turnId } = completedResponse(aggregateCandidate);
  const database = conversations.getConversationDatabase();
  const day = (database.prepare("SELECT response_day_utc AS day FROM response_feedback WHERE turn_id = ?")
    .get(turnId) as { day: string }).day;

  const saved = feedback.setResponseFeedback(database, conversation.id, turnId, "helpful", "2026-08-11T10:00:00.000Z");
  assert.deepEqual(saved, { kind: "updated", feedback: { turnId, rating: "helpful" }, outcome: "saved" });
  assert.equal(feedback.setResponseFeedback(database, conversation.id, turnId, "helpful", "2026-08-11T10:01:00.000Z").kind, "updated");
  const changed = feedback.setResponseFeedback(database, conversation.id, turnId, "needs-improvement", "2026-08-11T10:02:00.000Z");
  assert.equal(changed.kind === "updated" && changed.outcome, "changed");
  assert.deepEqual(feedback.aggregateResponseFeedback(database, aggregateCandidate, day), {
    eligibleResponses: 1,
    helpful: 0,
    needsImprovement: 1,
    rated: 1,
    unrated: 0,
  });
  const cleared = feedback.setResponseFeedback(database, conversation.id, turnId, null, "2026-08-11T10:03:00.000Z");
  assert.equal(cleared.kind === "updated" && cleared.outcome, "cleared");
  assert.deepEqual(feedback.aggregateResponseFeedback(database, aggregateCandidate, day), {
    eligibleResponses: 1,
    helpful: 0,
    needsImprovement: 0,
    rated: 0,
    unrated: 1,
  });
  const count = database.prepare("SELECT COUNT(*) AS count FROM response_feedback WHERE turn_id = ?").get(turnId) as { count: number };
  assert.equal(count.count, 1);
});

test("unknown, failed, and cancelled turns are never eligible", () => {
  const unknown = completedResponse(null);
  const failedConversation = conversations.createConversation([]);
  const failedId = randomUUID();
  turns.beginConversationTurn({ id: failedId, conversationId: failedConversation.id, userMessage: { role: "user", content: "Fail." }, options: { mode: "smart" } });
  turns.failConversationTurn(failedId, "internal", "Synthetic failure.");
  const cancelledId = randomUUID();
  turns.beginConversationTurn({ id: cancelledId, conversationId: failedConversation.id, userMessage: { role: "user", content: "Cancel." }, options: { mode: "smart" } });
  turns.cancelConversationTurn(cancelledId);
  const ids = conversations.getConversationDatabase().prepare("SELECT turn_id AS turnId FROM response_feedback WHERE turn_id IN (?, ?, ?)")
    .all(unknown.turnId, failedId, cancelledId) as Array<{ turnId: string }>;
  assert.deepEqual(ids, []);
});

test("feedback cannot cross conversation boundaries and conversation deletion cascades", () => {
  const first = completedResponse();
  const other = conversations.createConversation([]);
  assert.deepEqual(
    feedback.setResponseFeedback(conversations.getConversationDatabase(), other.id, first.turnId, "helpful"),
    { kind: "not-found" },
  );
  assert.equal(conversations.deleteConversation(first.conversation.id), true);
  assert.equal(conversations.getConversationDatabase().prepare("SELECT turn_id FROM response_feedback WHERE turn_id = ?").get(first.turnId), undefined);
});

test("feedback insertion rolls back when the canonical conversation update fails", () => {
  const conversation = conversations.createConversation([]);
  const turnId = randomUUID();
  turns.beginConversationTurn({ id: turnId, conversationId: conversation.id, userMessage: { role: "user", content: "Rollback." }, options: { mode: "smart" } });
  turns.claimConversationTurn(conversation.id, turnId);
  const database = conversations.getConversationDatabase();
  database.exec(`
    CREATE TRIGGER response_feedback_completion_abort
    BEFORE UPDATE OF messages ON conversations
    BEGIN SELECT RAISE(ABORT, 'synthetic completion failure'); END;
  `);
  assert.throws(
    () => turns.completeConversationTurn(turnId, { role: "assistant", content: "Must roll back." }, candidateBuildId),
    /synthetic completion failure/,
  );
  database.exec("DROP TRIGGER response_feedback_completion_abort");
  assert.equal(database.prepare("SELECT turn_id FROM response_feedback WHERE turn_id = ?").get(turnId), undefined);
  assert.equal(turns.getConversationTurn(turnId)?.status, "pending");
  turns.failConversationTurn(turnId, "internal", "Synthetic rollback complete.");
});

test("malformed feedback schemas fail closed", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (key TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE conversation_turns (id TEXT PRIMARY KEY);
    CREATE TABLE response_feedback (turn_id TEXT PRIMARY KEY, rating TEXT);
  `);
  assert.throws(() => feedback.ensureResponseFeedbackSchema(database), /response-feedback schema is incompatible/);
  database.close();
});
