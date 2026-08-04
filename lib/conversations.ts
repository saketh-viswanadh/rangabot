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

function getDatabase() {
  if (database) return database;
  mkdirSync(dirname(databasePath), { recursive: true });
  database = new DatabaseSync(databasePath);
  database.exec(`
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
  `);
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
  return database;
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
    conditions.push("(lower(title) LIKE ? ESCAPE '\\' OR lower(messages) LIKE ? ESCAPE '\\')");
    const escaped = query.replace(/[\\%_]/g, "\\$&");
    parameters.push(`%${escaped}%`, `%${escaped}%`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = getDatabase().prepare(`
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
  getDatabase().prepare(`
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
  const row = getDatabase().prepare(`
    SELECT id, title, messages, project_id AS projectId, dataset_id AS datasetId, pinned, created_at AS createdAt, updated_at AS updatedAt
    FROM conversations WHERE id = ?
  `).get(id) as unknown as (ConversationSummaryRow & { messages: string }) | undefined;
  return row ? { ...toConversationSummary(row), messages: parseMessages(row.messages) } : null;
}

export function updateConversation(id: string, messages: ChatMessage[]): Conversation | null {
  const updatedAt = new Date().toISOString();
  const result = getDatabase().prepare(`
    UPDATE conversations
    SET title = ?, messages = ?, updated_at = ?
    WHERE id = ?
  `).run(titleFromMessages(messages), JSON.stringify(messages), updatedAt, id);
  return result.changes ? getConversation(id) : null;
}

export function deleteConversation(id: string): boolean {
  return getDatabase().prepare("DELETE FROM conversations WHERE id = ?").run(id).changes > 0;
}

export function setConversationPinned(id: string, pinned: boolean): ConversationSummary | null {
  const result = getDatabase().prepare("UPDATE conversations SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id);
  if (!result.changes) return null;
  const row = getDatabase().prepare(`
    SELECT id, title, project_id AS projectId, dataset_id AS datasetId, pinned, created_at AS createdAt, updated_at AS updatedAt
    FROM conversations WHERE id = ?
  `).get(id) as unknown as ConversationSummaryRow;
  return toConversationSummary(row);
}

export function setConversationDataset(id: string, datasetId: string | null): Conversation | null {
  const updatedAt = new Date().toISOString();
  const result = getDatabase().prepare("UPDATE conversations SET dataset_id = ?, updated_at = ? WHERE id = ?")
    .run(datasetId, updatedAt, id);
  return result.changes ? getConversation(id) : null;
}

export function listProjects(): ProjectSummary[] {
  return getDatabase().prepare(`
    SELECT id, name, created_at AS createdAt, updated_at AS updatedAt
    FROM projects ORDER BY updated_at DESC
  `).all() as unknown as ProjectSummary[];
}

export function createProject(name: string): ProjectSummary {
  const now = new Date().toISOString();
  const project = { id: randomUUID(), name: name.trim(), createdAt: now, updatedAt: now };
  getDatabase().prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(project.id, project.name, project.createdAt, project.updatedAt);
  return project;
}

export function updateProject(id: string, name: string): ProjectSummary | null {
  const updatedAt = new Date().toISOString();
  const result = getDatabase().prepare("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?")
    .run(name.trim(), updatedAt, id);
  if (!result.changes) return null;
  return getDatabase().prepare("SELECT id, name, created_at AS createdAt, updated_at AS updatedAt FROM projects WHERE id = ?")
    .get(id) as unknown as ProjectSummary;
}

export function deleteProject(id: string): boolean {
  const db = getDatabase();
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
