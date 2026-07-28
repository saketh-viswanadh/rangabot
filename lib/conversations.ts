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
  `);
  return database;
}

function parseMessages(value: string): ChatMessage[] {
  return JSON.parse(value) as ChatMessage[];
}

export function listConversations(): ConversationSummary[] {
  return getDatabase().prepare(`
    SELECT id, title, created_at AS createdAt, updated_at AS updatedAt
    FROM conversations
    ORDER BY updated_at DESC
  `).all() as unknown as ConversationSummary[];
}

export function createConversation(messages: ChatMessage[]): Conversation {
  const now = new Date().toISOString();
  const conversation: Conversation = {
    id: randomUUID(),
    title: titleFromMessages(messages),
    messages,
    createdAt: now,
    updatedAt: now,
  };
  getDatabase().prepare(`
    INSERT INTO conversations (id, title, messages, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    conversation.id,
    conversation.title,
    JSON.stringify(conversation.messages),
    conversation.createdAt,
    conversation.updatedAt,
  );
  return conversation;
}

export function getConversation(id: string): Conversation | null {
  const row = getDatabase().prepare(`
    SELECT id, title, messages, created_at AS createdAt, updated_at AS updatedAt
    FROM conversations WHERE id = ?
  `).get(id) as unknown as (ConversationSummary & { messages: string }) | undefined;
  return row ? { ...row, messages: parseMessages(row.messages) } : null;
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
