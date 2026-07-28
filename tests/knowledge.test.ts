import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

process.env.KNOWLEDGE_DISABLE_EMBEDDINGS = "1";
const knowledge = await import("../lib/knowledge.ts");
const testDatabase = resolve("data/knowledge-test.db");
knowledge.setKnowledgeDatabasePathForTests(testDatabase);

test.after(() => {
  knowledge.closeKnowledgeDatabaseForTests();
  for (const suffix of ["", "-shm", "-wal"]) rmSync(`${testDatabase}${suffix}`, { force: true });
});

test("indexes and retrieves a cited local teaching passage", async () => {
  knowledge.saveKnowledgeDocument({
    id: randomUUID(), path: "/private/local/python.txt", title: "Python lesson", format: "txt", sizeBytes: 100, sha256: "test-hash",
    chunks: [{ id: randomUUID(), ordinal: 1, content: "Python handles runtime errors with try and except clauses." }],
  });
  const results = await knowledge.searchKnowledge("Python runtime exceptions", 3);
  assert.equal(results[0]?.title, "Python lesson");
  assert.equal(results[0]?.chunk, 1);
  assert.match(results[0]?.content ?? "", /try and except/);
});

test("recognizes broad teaching-capability questions instead of retrieving a random passage", () => {
  assert.equal(knowledge.isKnowledgeCatalogQuestion("What all can you teach?"), true);
  assert.equal(knowledge.isKnowledgeCatalogQuestion("Which topics can I learn here?"), true);
  assert.equal(knowledge.isKnowledgeCatalogQuestion("Explain Python exceptions"), false);
});
