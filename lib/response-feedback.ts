import type { DatabaseSync as Database } from "node:sqlite";
import {
  RESPONSE_FEEDBACK_SCHEMA_VERSION,
  type ResponseFeedbackMutationOutcome,
  type ResponseFeedbackRating,
  type ResponseFeedbackView,
} from "./response-feedback-contract.ts";

const candidateBuildIdPattern = /^[0-9a-f]{64}$/;
const utcDayPattern = /^\d{4}-\d{2}-\d{2}$/;

export type ResponseFeedbackAggregateCounts = {
  eligibleResponses: number;
  helpful: number;
  needsImprovement: number;
  rated: number;
  unrated: number;
};

export type ResponseFeedbackMutation = {
  kind: "updated";
  feedback: ResponseFeedbackView;
  outcome: ResponseFeedbackMutationOutcome;
} | { kind: "not-found" };

function incompatibleFeedbackSchema(detail: string): never {
  throw new Error(`The local response-feedback schema is incompatible (${detail}). Back up data/rangabot.db before repair.`);
}

function canonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function indexColumns(database: Database, name: string) {
  return (database.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(name) as unknown as Array<{ name: string }>)
    .map((column) => column.name);
}

export function ensureResponseFeedbackSchema(database: Database) {
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS response_feedback (
        turn_id TEXT PRIMARY KEY REFERENCES conversation_turns(id) ON DELETE CASCADE,
        rating TEXT CHECK (rating IS NULL OR rating IN ('helpful', 'needs-improvement')),
        candidate_build_id TEXT NOT NULL CHECK (length(candidate_build_id) = 64),
        response_day_utc TEXT NOT NULL CHECK (length(response_day_utc) = 10),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS response_feedback_daily
        ON response_feedback(candidate_build_id, response_day_utc);
    `);
  } catch {
    incompatibleFeedbackSchema("table or daily index is invalid");
  }
  validateResponseFeedbackSchema(database);
  const migrationKey = `response-feedback-v${RESPONSE_FEEDBACK_SCHEMA_VERSION}`;
  const migration = database.prepare("SELECT key, applied_at AS appliedAt FROM schema_migrations WHERE key = ?")
    .get(migrationKey) as { key: string; appliedAt: string } | undefined;
  if (!migration) {
    database.prepare("INSERT INTO schema_migrations (key, applied_at) VALUES (?, ?)")
      .run(migrationKey, new Date().toISOString());
  }
  const applied = migration ?? database.prepare("SELECT key, applied_at AS appliedAt FROM schema_migrations WHERE key = ?")
    .get(migrationKey) as { key: string; appliedAt: string } | undefined;
  if (!applied || applied.key !== migrationKey || !canonicalIsoTimestamp(applied.appliedAt)) {
    incompatibleFeedbackSchema("migration marker is invalid");
  }
}

export function validateResponseFeedbackSchema(database: Database) {
  const columns = database.prepare("PRAGMA table_info(response_feedback)").all() as unknown as Array<{
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }>;
  const expected = new Map<string, { type: string; required: boolean }>([
    ["turn_id", { type: "TEXT", required: true }],
    ["rating", { type: "TEXT", required: false }],
    ["candidate_build_id", { type: "TEXT", required: true }],
    ["response_day_utc", { type: "TEXT", required: true }],
    ["created_at", { type: "TEXT", required: true }],
    ["updated_at", { type: "TEXT", required: true }],
  ]);
  if (columns.length !== expected.size) incompatibleFeedbackSchema("columns are invalid");
  for (const [name, rule] of expected) {
    const column = columns.find((candidate) => candidate.name === name);
    if (!column || column.type.toUpperCase() !== rule.type
      || (name !== "turn_id" && Boolean(column.notnull) !== rule.required)) {
      incompatibleFeedbackSchema(`invalid column ${name}`);
    }
  }
  const primaryKeys = columns.filter((column) => column.pk > 0);
  if (primaryKeys.length !== 1 || primaryKeys[0].name !== "turn_id" || primaryKeys[0].pk !== 1) {
    incompatibleFeedbackSchema("turn_id is not the primary key");
  }
  const foreignKeys = database.prepare("PRAGMA foreign_key_list(response_feedback)").all() as unknown as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (foreignKeys.length !== 1 || foreignKeys[0].table !== "conversation_turns"
    || foreignKeys[0].from !== "turn_id" || foreignKeys[0].to !== "id"
    || foreignKeys[0].on_delete.toUpperCase() !== "CASCADE") {
    incompatibleFeedbackSchema("turn foreign key is invalid");
  }
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'response_feedback'")
    .get() as { sql?: string } | undefined;
  const sql = row?.sql?.toLowerCase().replace(/[\s"`\[\]]+/g, "") ?? "";
  if (!sql.includes("check(ratingisnullorratingin('helpful','needs-improvement'))")
    || !sql.includes("check(length(candidate_build_id)=64)")
    || !sql.includes("check(length(response_day_utc)=10)")) {
    incompatibleFeedbackSchema("required CHECK constraints are missing");
  }
  const indexes = database.prepare("PRAGMA index_list(response_feedback)").all() as unknown as Array<{
    name: string;
    unique: number;
    partial: number;
  }>;
  const daily = indexes.find((index) => index.name === "response_feedback_daily");
  if (!daily || daily.unique || daily.partial
    || indexColumns(database, daily.name).join(",") !== "candidate_build_id,response_day_utc") {
    incompatibleFeedbackSchema("daily aggregate index is invalid");
  }
}

export function recordCompletedResponseFeedback(
  database: Database,
  turnId: string,
  candidateBuildId: string | null,
  completedAt: string,
) {
  if (!candidateBuildId) return false;
  if (!candidateBuildIdPattern.test(candidateBuildId) || !canonicalIsoTimestamp(completedAt)) {
    throw new Error("Completed response feedback requires verified candidate provenance and a canonical completion time.");
  }
  const day = completedAt.slice(0, 10);
  database.prepare(`
    INSERT INTO response_feedback (
      turn_id, rating, candidate_build_id, response_day_utc, created_at, updated_at
    ) VALUES (?, NULL, ?, ?, ?, ?)
  `).run(turnId, candidateBuildId, day, completedAt, completedAt);
  return true;
}

export function listConversationResponseFeedback(database: Database, conversationId: string): ResponseFeedbackView[] {
  const rows = database.prepare(`
    SELECT feedback.turn_id AS turnId, feedback.rating
    FROM response_feedback feedback
    JOIN conversation_turns turn ON turn.id = feedback.turn_id
    WHERE turn.conversation_id = ? AND turn.status = 'completed'
    ORDER BY turn.sequence ASC
  `).all(conversationId) as unknown as ResponseFeedbackView[];
  return rows.map((row) => ({ turnId: row.turnId, rating: row.rating }));
}

export function setResponseFeedback(
  database: Database,
  conversationId: string,
  turnId: string,
  rating: ResponseFeedbackRating | null,
  now = new Date().toISOString(),
): ResponseFeedbackMutation {
  if (rating !== null && rating !== "helpful" && rating !== "needs-improvement") {
    throw new Error("A supported feedback value or null is required.");
  }
  if (!canonicalIsoTimestamp(now)) throw new Error("A canonical feedback update time is required.");
  database.exec("BEGIN IMMEDIATE");
  try {
    const existing = database.prepare(`
      SELECT feedback.rating
      FROM response_feedback feedback
      JOIN conversation_turns turn ON turn.id = feedback.turn_id
      WHERE feedback.turn_id = ? AND turn.conversation_id = ? AND turn.status = 'completed'
    `).get(turnId, conversationId) as { rating: ResponseFeedbackRating | null } | undefined;
    if (!existing) {
      database.exec("ROLLBACK");
      return { kind: "not-found" };
    }
    const outcome: ResponseFeedbackMutationOutcome = existing.rating === rating
      ? "unchanged"
      : rating === null
        ? "cleared"
        : existing.rating === null
          ? "saved"
          : "changed";
    if (outcome !== "unchanged") {
      const updated = database.prepare("UPDATE response_feedback SET rating = ?, updated_at = ? WHERE turn_id = ?")
        .run(rating, now, turnId);
      if (updated.changes !== 1) throw new Error("The local feedback row changed unexpectedly.");
    }
    database.exec("COMMIT");
    return { kind: "updated", feedback: { turnId, rating }, outcome };
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Preserve the mutation error. */ }
    throw error;
  }
}

export function aggregateResponseFeedback(
  database: Database,
  candidateBuildId: string,
  dayUtc: string,
): ResponseFeedbackAggregateCounts {
  if (!candidateBuildIdPattern.test(candidateBuildId) || !utcDayPattern.test(dayUtc)
    || new Date(`${dayUtc}T00:00:00.000Z`).toISOString().slice(0, 10) !== dayUtc) {
    throw new Error("A verified candidate build and valid UTC day are required.");
  }
  const row = database.prepare(`
    SELECT
      COUNT(*) AS eligibleResponses,
      SUM(CASE WHEN rating = 'helpful' THEN 1 ELSE 0 END) AS helpful,
      SUM(CASE WHEN rating = 'needs-improvement' THEN 1 ELSE 0 END) AS needsImprovement,
      SUM(CASE WHEN rating IS NOT NULL THEN 1 ELSE 0 END) AS rated
    FROM response_feedback
    WHERE candidate_build_id = ? AND response_day_utc = ?
  `).get(candidateBuildId, dayUtc) as {
    eligibleResponses: number;
    helpful: number;
    needsImprovement: number;
    rated: number;
  };
  const eligibleResponses = Number(row.eligibleResponses ?? 0);
  const helpful = Number(row.helpful ?? 0);
  const needsImprovement = Number(row.needsImprovement ?? 0);
  const rated = Number(row.rated ?? 0);
  return { eligibleResponses, helpful, needsImprovement, rated, unrated: eligibleResponses - rated };
}
