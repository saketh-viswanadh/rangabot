import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { DatabaseSync as Database } from "node:sqlite";
import type { ChatMessage } from "./providers/types";

const serverRequire = createRequire(resolve(process.cwd(), "package.json"));
const { DatabaseSync } = serverRequire("node:sqlite") as typeof import("node:sqlite");

export interface ConversationSummary {
  id: string;
  title: string;
  projectId: string | null;
  datasetId: string | null;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface Conversation extends ConversationSummary {
  messages: ChatMessage[];
}

const defaultDatabasePath = resolve(process.cwd(), "data", "rangabot.db");
let databasePath = defaultDatabasePath;
let database: Database | undefined;

export function getConversationDatabase() {
  if (database) return database;
  mkdirSync(dirname(databasePath), { recursive: true });
  database = new DatabaseSync(databasePath);
  let transactionStarted = false;
  try {
    database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      messages TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schema_migrations (
      key TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    `);
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    validateSchemaMigrationsTable(database);
    const columns = database.prepare("PRAGMA table_info(conversations)").all() as unknown as { name: string }[];
    if (!columns.some((column) => column.name === "project_id")) {
      database.exec("ALTER TABLE conversations ADD COLUMN project_id TEXT");
    }
    if (!columns.some((column) => column.name === "pinned")) {
      database.exec("ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
    }
    if (!columns.some((column) => column.name === "dataset_id")) {
      database.exec("ALTER TABLE conversations ADD COLUMN dataset_id TEXT");
    }
    database.exec(`
    CREATE TABLE IF NOT EXISTS conversation_turns (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'cancelled', 'failed')),
      request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
      user_message TEXT NOT NULL,
      request_options TEXT NOT NULL,
      assistant_message TEXT,
      failure_code TEXT,
      failure_message TEXT,
      context_message_count INTEGER NOT NULL CHECK (context_message_count >= 0),
      execution_started_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT,
      UNIQUE (conversation_id, sequence)
    );
    `);
    validateConversationTurnTable(database);
    database.exec(`
    CREATE INDEX IF NOT EXISTS conversation_turns_order
      ON conversation_turns(conversation_id, sequence);
    CREATE UNIQUE INDEX IF NOT EXISTS conversation_one_pending_turn
      ON conversation_turns(conversation_id) WHERE status = 'pending';
    `);
    validateConversationTurnIndexes(database);
    const migrationKey = "conversation-turn-lifecycle-v1";
    const migration = database.prepare("SELECT key, applied_at AS appliedAt FROM schema_migrations WHERE key = ?")
      .get(migrationKey) as { key: string; appliedAt: string } | undefined;
    if (!migration) database.prepare("INSERT INTO schema_migrations (key, applied_at) VALUES (?, ?)")
      .run(migrationKey, new Date().toISOString());
    const applied = migration ?? database.prepare("SELECT key, applied_at AS appliedAt FROM schema_migrations WHERE key = ?")
      .get(migrationKey) as { key: string; appliedAt: string } | undefined;
    if (!applied || applied.key !== migrationKey || !isCanonicalIsoTimestamp(applied.appliedAt)) {
      incompatibleTurnSchema("lifecycle migration marker is invalid");
    }
    database.exec("COMMIT");
    transactionStarted = false;
    return database;
  } catch (error) {
    if (transactionStarted) {
      try { database.exec("ROLLBACK"); } catch { /* Closing below is authoritative. */ }
    }
    try { database.close(); } catch { /* Preserve the initialization error. */ }
    database = undefined;
    throw error;
  }
}

function incompatibleTurnSchema(detail: string): never {
  throw new Error(`The local conversation-turn schema is incompatible (${detail}). Back up data/rangabot.db before repair.`);
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function validateSchemaMigrationsTable(db: Database) {
  const columns = db.prepare("PRAGMA table_info(schema_migrations)").all() as unknown as Array<{ name: string; type: string; notnull: number; pk: number }>;
  if (columns.length !== 2) incompatibleTurnSchema("schema_migrations columns are invalid");
  const key = columns.find((column) => column.name === "key");
  const appliedAt = columns.find((column) => column.name === "applied_at");
  if (!key || key.type.toUpperCase() !== "TEXT" || key.pk !== 1
    || !appliedAt || appliedAt.type.toUpperCase() !== "TEXT" || !appliedAt.notnull || appliedAt.pk !== 0) {
    incompatibleTurnSchema("schema_migrations columns are invalid");
  }
}

function validateConversationTurnTable(db: Database) {
  const columns = db.prepare("PRAGMA table_info(conversation_turns)").all() as unknown as Array<{ name: string; type: string; notnull: number; pk: number }>;
  const expected = new Map<string, { type: string; required: boolean }>([
    ["id", { type: "TEXT", required: true }], ["conversation_id", { type: "TEXT", required: true }],
    ["sequence", { type: "INTEGER", required: true }], ["status", { type: "TEXT", required: true }],
    ["request_hash", { type: "TEXT", required: true }], ["user_message", { type: "TEXT", required: true }],
    ["request_options", { type: "TEXT", required: true }], ["assistant_message", { type: "TEXT", required: false }],
    ["failure_code", { type: "TEXT", required: false }], ["failure_message", { type: "TEXT", required: false }],
    ["context_message_count", { type: "INTEGER", required: true }], ["execution_started_at", { type: "TEXT", required: false }],
    ["created_at", { type: "TEXT", required: true }], ["updated_at", { type: "TEXT", required: true }],
    ["finished_at", { type: "TEXT", required: false }],
  ]);
  const unexpected = columns.filter((column) => !expected.has(column.name));
  if (unexpected.length) incompatibleTurnSchema(`unexpected column ${unexpected[0].name}`);
  for (const [name, rule] of expected) {
    const column = columns.find((candidate) => candidate.name === name);
    if (!column) incompatibleTurnSchema(`missing column ${name}`);
    if (column.type.toUpperCase() !== rule.type
      || (name !== "id" && Boolean(column.notnull) !== rule.required)) incompatibleTurnSchema(`invalid column ${name}`);
  }
  const primaryKeys = columns.filter((column) => column.pk > 0);
  if (primaryKeys.length !== 1 || primaryKeys[0].name !== "id" || primaryKeys[0].pk !== 1) incompatibleTurnSchema("id is not the primary key");

  const foreignKeys = db.prepare("PRAGMA foreign_key_list(conversation_turns)").all() as unknown as Array<{
    table: string; from: string; to: string; on_delete: string;
  }>;
  if (!foreignKeys.some((key) => key.table === "conversations" && key.from === "conversation_id"
    && key.to === "id" && key.on_delete.toUpperCase() === "CASCADE")) incompatibleTurnSchema("conversation foreign key is invalid");

  const indexes = db.prepare("PRAGMA index_list(conversation_turns)").all() as unknown as Array<{ name: string; unique: number; partial: number }>;
  const hasSequenceConstraint = indexes.some((index) => index.unique && !index.partial
    && indexColumns(db, index.name).join(",") === "conversation_id,sequence");
  if (!hasSequenceConstraint) incompatibleTurnSchema("conversation sequence constraint is invalid");

  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversation_turns'").get() as { sql?: string } | undefined;
  const sql = row?.sql?.toLowerCase().replace(/[\s"`\[\]]+/g, "") ?? "";
  if (!sql.includes("check(sequence>=1)")
    || !sql.includes("check(statusin('pending','completed','cancelled','failed'))")
    || !sql.includes("check(length(request_hash)=64)")
    || !sql.includes("check(context_message_count>=0)")) incompatibleTurnSchema("required CHECK constraints are missing");
}

function indexColumns(db: Database, name: string) {
  return (db.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(name) as unknown as Array<{ name: string }>).map((column) => column.name);
}

function validateConversationTurnIndexes(db: Database) {
  const indexes = db.prepare("PRAGMA index_list(conversation_turns)").all() as unknown as Array<{ name: string; unique: number; partial: number }>;
  const ordered = indexes.find((index) => index.name === "conversation_turns_order");
  const pending = indexes.find((index) => index.name === "conversation_one_pending_turn");
  if (!ordered || ordered.unique || ordered.partial || indexColumns(db, ordered.name).join(",") !== "conversation_id,sequence") incompatibleTurnSchema("conversation order index is invalid");
  if (!pending || !pending.unique || !pending.partial || indexColumns(db, pending.name).join(",") !== "conversation_id") incompatibleTurnSchema("pending-turn index is invalid");
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'conversation_one_pending_turn'").get() as { sql?: string } | undefined;
  const normalized = row?.sql?.toLowerCase().replace(/[\s"`\[\]]+/g, "").replace(/;$/, "") ?? "";
  const expected = "createuniqueindexconversation_one_pending_turnonconversation_turns(conversation_id)wherestatus='pending'";
  if (normalized !== expected) incompatibleTurnSchema("pending-turn constraint is invalid");
}

function parseMessages(value: string): ChatMessage[] {
  return JSON.parse(value) as ChatMessage[];
}

type ConversationSummaryRow = Omit<ConversationSummary, "pinned"> & { pinned: number };

function toConversationSummary(row: ConversationSummaryRow): ConversationSummary {
  return { ...row, pinned: Boolean(row.pinned) };
}

export function listConversations(options: { query?: string; projectId?: string | null } = {}): ConversationSummary[] {
  const query = options.query?.trim().toLocaleLowerCase() ?? "";
  const conditions: string[] = [];
  const parameters: string[] = [];
  if (options.projectId) {
    conditions.push("project_id = ?");
    parameters.push(options.projectId);
  }
  if (query) {
    conditions.push(`(lower(title) LIKE ? ESCAPE '\\' OR lower(messages) LIKE ? ESCAPE '\\' OR EXISTS (
      SELECT 1 FROM conversation_turns turn
      WHERE turn.conversation_id = conversations.id
        AND turn.status = 'completed'
        AND (lower(turn.user_message) LIKE ? ESCAPE '\\' OR lower(COALESCE(turn.assistant_message, '')) LIKE ? ESCAPE '\\')
    ))`);
    const escaped = query.replace(/[\\%_]/g, "\\$&");
    parameters.push(`%${escaped}%`, `%${escaped}%`, `%${escaped}%`, `%${escaped}%`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = getConversationDatabase().prepare(`
    SELECT id, title, project_id AS projectId, dataset_id AS datasetId, pinned, created_at AS createdAt, updated_at AS updatedAt
    FROM conversations
    ${where}
    ORDER BY pinned DESC, updated_at DESC
  `).all(...parameters) as unknown as ConversationSummaryRow[];
  return rows.map(toConversationSummary);
}

export function createConversation(messages: ChatMessage[], projectId: string | null = null, datasetId: string | null = null): Conversation {
  const now = new Date().toISOString();
  const conversation: Conversation = {
    id: randomUUID(),
    title: titleFromMessages(messages),
    projectId,
    datasetId,
    pinned: false,
    messages,
    createdAt: now,
    updatedAt: now,
  };
  getConversationDatabase().prepare(`
    INSERT INTO conversations (id, title, messages, project_id, dataset_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    conversation.id,
    conversation.title,
    JSON.stringify(conversation.messages),
    conversation.projectId,
    conversation.datasetId,
    conversation.createdAt,
    conversation.updatedAt,
  );
  return conversation;
}

export function getConversation(id: string): Conversation | null {
  const row = getConversationDatabase().prepare(`
    SELECT id, title, messages, project_id AS projectId, dataset_id AS datasetId, pinned, created_at AS createdAt, updated_at AS updatedAt
    FROM conversations WHERE id = ?
  `).get(id) as unknown as (ConversationSummaryRow & { messages: string }) | undefined;
  return row ? { ...toConversationSummary(row), messages: parseMessages(row.messages) } : null;
}

export function updateConversation(id: string, messages: ChatMessage[]): Conversation | null {
  if (isConversationLifecycleManaged(id)) {
    throw new Error("This conversation is lifecycle-managed and cannot be replaced as a whole transcript.");
  }
  const updatedAt = new Date().toISOString();
  const result = getConversationDatabase().prepare(`
    UPDATE conversations
    SET title = ?, messages = ?, updated_at = ?
    WHERE id = ?
  `).run(titleFromMessages(messages), JSON.stringify(messages), updatedAt, id);
  return result.changes ? getConversation(id) : null;
}

export function isConversationLifecycleManaged(id: string) {
  return Boolean(getConversationDatabase().prepare("SELECT 1 FROM conversation_turns WHERE conversation_id = ? LIMIT 1").get(id));
}

export function deleteConversation(id: string): boolean {
  return getConversationDatabase().prepare("DELETE FROM conversations WHERE id = ?").run(id).changes > 0;
}

export function setConversationPinned(id: string, pinned: boolean): ConversationSummary | null {
  const result = getConversationDatabase().prepare("UPDATE conversations SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id);
  if (!result.changes) return null;
  const row = getConversationDatabase().prepare(`
    SELECT id, title, project_id AS projectId, dataset_id AS datasetId, pinned, created_at AS createdAt, updated_at AS updatedAt
    FROM conversations WHERE id = ?
  `).get(id) as unknown as ConversationSummaryRow;
  return toConversationSummary(row);
}

export function setConversationDataset(id: string, datasetId: string | null): Conversation | null {
  const updatedAt = new Date().toISOString();
  const result = getConversationDatabase().prepare("UPDATE conversations SET dataset_id = ?, updated_at = ? WHERE id = ?")
    .run(datasetId, updatedAt, id);
  return result.changes ? getConversation(id) : null;
}

export function listProjects(): ProjectSummary[] {
  return getConversationDatabase().prepare(`
    SELECT id, name, created_at AS createdAt, updated_at AS updatedAt
    FROM projects ORDER BY updated_at DESC
  `).all() as unknown as ProjectSummary[];
}

export function createProject(name: string): ProjectSummary {
  const now = new Date().toISOString();
  const project = { id: randomUUID(), name: name.trim(), createdAt: now, updatedAt: now };
  getConversationDatabase().prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(project.id, project.name, project.createdAt, project.updatedAt);
  return project;
}

export function updateProject(id: string, name: string): ProjectSummary | null {
  const updatedAt = new Date().toISOString();
  const result = getConversationDatabase().prepare("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?")
    .run(name.trim(), updatedAt, id);
  if (!result.changes) return null;
  return getConversationDatabase().prepare("SELECT id, name, created_at AS createdAt, updated_at AS updatedAt FROM projects WHERE id = ?")
    .get(id) as unknown as ProjectSummary;
}

export function deleteProject(id: string): boolean {
  const db = getConversationDatabase();
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE conversations SET project_id = NULL WHERE project_id = ?").run(id);
    const deleted = db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes > 0;
    db.exec("COMMIT");
    return deleted;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function titleFromMessages(messages: ChatMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === "user")?.content.trim();
  if (!firstUserMessage) return "New conversation";
  return firstUserMessage.length > 42 ? `${firstUserMessage.slice(0, 39)}…` : firstUserMessage;
}

export function closeConversationDatabaseForTests() {
  database?.close();
  database = undefined;
}

export function setConversationDatabasePathForTests(path: string) {
  closeConversationDatabaseForTests();
  databasePath = path;
}
