import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const conversations = await import("../lib/conversations.ts");

const turnTable = `
  CREATE TABLE conversation_turns (
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
`;

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "rangabot-schema-"));
  const path = join(root, "rangabot.db");
  return {
    path,
    close() {
      conversations.closeConversationDatabaseForTests();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function createLegacyConversations(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      messages TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function actionableSchemaError(error: unknown, detail: RegExp) {
  return error instanceof Error
    && /local conversation-turn schema is incompatible/.test(error.message)
    && detail.test(error.message)
    && /Back up data\/rangabot\.db before repair/.test(error.message);
}

test("upgrades a clean legacy database and records a validated lifecycle marker and indexes", () => {
  const fixture = createFixture();
  try {
    const legacy = new DatabaseSync(fixture.path);
    createLegacyConversations(legacy);
    legacy.prepare("INSERT INTO conversations (id, title, messages, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("legacy", "Legacy", JSON.stringify([{ role: "user", content: "Keep this transcript." }]), "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    legacy.close();

    conversations.setConversationDatabasePathForTests(fixture.path);
    const database = conversations.getConversationDatabase();
    const marker = database.prepare("SELECT key, applied_at AS appliedAt FROM schema_migrations WHERE key = ?")
      .get("conversation-turn-lifecycle-v1") as { key: string; appliedAt: string } | undefined;
    const indexes = database.prepare("PRAGMA index_list(conversation_turns)").all() as Array<{ name: string }>;

    assert.equal(marker?.key, "conversation-turn-lifecycle-v1");
    assert.equal(Number.isFinite(Date.parse(marker?.appliedAt ?? "")), true);
    assert.equal(indexes.some((index) => index.name === "conversation_turns_order"), true);
    assert.equal(indexes.some((index) => index.name === "conversation_one_pending_turn"), true);
    assert.deepEqual(conversations.getConversation("legacy")?.messages, [{ role: "user", content: "Keep this transcript." }]);
  } finally {
    fixture.close();
  }
});

test("rejects a partial pre-existing turn table before creating indexes or a marker", () => {
  const fixture = createFixture();
  try {
    const malformed = new DatabaseSync(fixture.path);
    createLegacyConversations(malformed);
    malformed.exec(`
      CREATE TABLE conversation_turns (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        sequence INTEGER NOT NULL
      );
    `);
    malformed.close();

    conversations.setConversationDatabasePathForTests(fixture.path);
    assert.throws(
      () => conversations.getConversationDatabase(),
      (error: unknown) => actionableSchemaError(error, /missing column status/),
    );

    const inspected = new DatabaseSync(fixture.path);
    const indexes = inspected.prepare("PRAGMA index_list(conversation_turns)").all() as Array<{ name: string }>;
    const marker = inspected.prepare("SELECT key FROM schema_migrations WHERE key = ?").get("conversation-turn-lifecycle-v1");
    assert.equal(indexes.some((index) => index.name.startsWith("conversation_")), false);
    assert.equal(marker, undefined);
    inspected.close();
  } finally {
    fixture.close();
  }
});

test("rejects a same-named conversation order index with the wrong column order", () => {
  const fixture = createFixture();
  try {
    const malformed = new DatabaseSync(fixture.path);
    createLegacyConversations(malformed);
    malformed.exec(turnTable);
    malformed.exec("CREATE INDEX conversation_turns_order ON conversation_turns(sequence, conversation_id)");
    malformed.close();

    conversations.setConversationDatabasePathForTests(fixture.path);
    assert.throws(
      () => conversations.getConversationDatabase(),
      (error: unknown) => actionableSchemaError(error, /conversation order index is invalid/),
    );
  } finally {
    fixture.close();
  }
});

test("rejects a same-named pending index with a weakened or expanded predicate", () => {
  for (const predicate of ["status = 'pending' AND 0", "status = 'pending' OR status = 'failed'"]) {
    const fixture = createFixture();
    try {
      const malformed = new DatabaseSync(fixture.path);
      createLegacyConversations(malformed);
      malformed.exec(turnTable);
      malformed.exec("CREATE INDEX conversation_turns_order ON conversation_turns(conversation_id, sequence)");
      malformed.exec(`CREATE UNIQUE INDEX conversation_one_pending_turn ON conversation_turns(conversation_id) WHERE ${predicate}`);
      malformed.close();

      conversations.setConversationDatabasePathForTests(fixture.path);
      assert.throws(
        () => conversations.getConversationDatabase(),
        (error: unknown) => actionableSchemaError(error, /pending-turn constraint is invalid/),
      );
    } finally {
      fixture.close();
    }
  }
});

test("a transient initialization lock never leaves an unmigrated handle cached", () => {
  const fixture = createFixture();
  try {
    const locker = new DatabaseSync(fixture.path);
    createLegacyConversations(locker);
    locker.exec("BEGIN IMMEDIATE");
    conversations.setConversationDatabasePathForTests(fixture.path);
    assert.throws(() => conversations.getConversationDatabase(), /locked|busy/i);
    locker.exec("ROLLBACK");
    locker.close();

    const recovered = conversations.getConversationDatabase();
    const marker = recovered.prepare("SELECT key FROM schema_migrations WHERE key = ?")
      .get("conversation-turn-lifecycle-v1") as { key: string } | undefined;
    assert.equal(marker?.key, "conversation-turn-lifecycle-v1");
    assert.equal(recovered.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversation_turns'").get() !== undefined, true);
  } finally {
    fixture.close();
  }
});

test("rejects a turn table that has the right columns but omits required CHECK constraints", () => {
  const fixture = createFixture();
  try {
    const malformed = new DatabaseSync(fixture.path);
    createLegacyConversations(malformed);
    malformed.exec(`
      CREATE TABLE conversation_turns (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        status TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        user_message TEXT NOT NULL,
        request_options TEXT NOT NULL,
        assistant_message TEXT,
        failure_code TEXT,
        failure_message TEXT,
        context_message_count INTEGER NOT NULL,
        execution_started_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE (conversation_id, sequence)
      );
    `);
    malformed.close();

    conversations.setConversationDatabasePathForTests(fixture.path);
    assert.throws(
      () => conversations.getConversationDatabase(),
      (error: unknown) => actionableSchemaError(error, /required CHECK constraints are missing/),
    );
  } finally {
    fixture.close();
  }
});

test("rejects a malformed migration registry and an invalid existing lifecycle marker", () => {
  const malformedRegistry = createFixture();
  try {
    const database = new DatabaseSync(malformedRegistry.path);
    database.exec("CREATE TABLE schema_migrations (key TEXT, applied_at TEXT)");
    database.close();
    conversations.setConversationDatabasePathForTests(malformedRegistry.path);
    assert.throws(
      () => conversations.getConversationDatabase(),
      (error: unknown) => actionableSchemaError(error, /schema_migrations columns are invalid/),
    );
  } finally {
    malformedRegistry.close();
  }

  const invalidMarker = createFixture();
  try {
    const database = new DatabaseSync(invalidMarker.path);
    database.exec("CREATE TABLE schema_migrations (key TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    database.prepare("INSERT INTO schema_migrations (key, applied_at) VALUES (?, ?)")
      .run("conversation-turn-lifecycle-v1", "2026-01-01");
    database.close();
    conversations.setConversationDatabasePathForTests(invalidMarker.path);
    assert.throws(
      () => conversations.getConversationDatabase(),
      (error: unknown) => actionableSchemaError(error, /lifecycle migration marker is invalid/),
    );
  } finally {
    invalidMarker.close();
  }
});
