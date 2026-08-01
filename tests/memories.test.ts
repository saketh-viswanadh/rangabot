import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import test, { after } from "node:test";

const testDatabase = resolve("data/memories-test.db");
const memories = await import("../lib/memories.ts");
memories.setMemoryDatabasePathForTests(testDatabase);

after(() => {
  memories.closeMemoryDatabaseForTests();
  for (const suffix of ["", "-shm", "-wal"]) if (existsSync(`${testDatabase}${suffix}`)) unlinkSync(`${testDatabase}${suffix}`);
});

test("creates, lists, edits and deletes explicit local memories", () => {
  const created = memories.createMemory("Prefer concise technical explanations", "preference");
  assert.equal(created.origin, "user-approved");
  assert.equal(created.confidence, 1);
  assert.equal(memories.listMemories()[0]?.id, created.id);
  const updated = memories.updateMemory(created.id, "Prefer concise explanations with examples", "instruction");
  assert.equal(updated?.kind, "instruction");
  assert.match(memories.formatMemoryContext() ?? "", /user-approved local memory/i);
  const exported = JSON.parse(memories.exportMemoriesJson("2026-07-30T00:00:00.000Z"));
  assert.equal(exported.version, 1);
  assert.equal(exported.memories[0].origin, "user-approved");
  assert.equal(exported.memories[0].confidence, 1);
  assert.equal(memories.deleteMemory(created.id), true);
  assert.equal(memories.listMemories().length, 0);
});

test("rejects silent or unbounded memory input", () => {
  assert.throws(() => memories.validateMemoryInput("", "fact"), /1–500/);
  assert.throws(() => memories.validateMemoryInput("x".repeat(501), "fact"), /1–500/);
  assert.throws(() => memories.validateMemoryInput("Secret", "inferred"), /kind/i);
});

test("answers direct identity recall from approved memory without model improvisation", () => {
  const name = memories.createMemory("My name is Saketh", "fact");
  assert.equal(memories.answerDirectMemoryQuestion("What is my name?"), "Your name is Saketh. You explicitly saved that in Local memory.");
  assert.match(memories.answerDirectMemoryQuestion("What do you remember about me?") ?? "", /My name is Saketh/);
  memories.deleteMemory(name.id);
  assert.match(memories.answerDirectMemoryQuestion("What's my name?") ?? "", /won't guess/);
});

test("previews duplicates and conflicts before an explicitly reviewed import", () => {
  const preference = memories.createMemory("Prefer concise answers", "preference");
  const name = memories.createMemory("My name is Saketh", "fact");
  const payload = {
    version: 1,
    exportedAt: "2026-08-01T00:00:00.000Z",
    memories: [
      { id: "duplicate", content: "prefer concise answers.", kind: "preference", origin: "user-approved", confidence: 1 },
      { id: "new", content: "Use dark mode by default", kind: "preference", origin: "user-approved", confidence: 1 },
      { id: "new-name", content: "My name is Ranga", kind: "fact", origin: "user-approved", confidence: 1 },
    ],
  };
  const preview = memories.previewMemoryImport(payload);
  assert.equal(preview.duplicates.length, 1);
  assert.equal(preview.newItems.length, 1);
  assert.equal(preview.conflicts[0]?.reason, "same-subject");
  const result = memories.applyMemoryImport(payload, ["new-name"]);
  assert.deepEqual(result, { imported: 1, replaced: 1, skippedDuplicates: 1, keptExisting: 0 });
  assert.match(memories.answerDirectMemoryQuestion("What is my name?") ?? "", /Ranga/);
  for (const memory of memories.listMemories()) memories.deleteMemory(memory.id);
  assert.equal(memories.deleteMemory(preference.id), false);
  assert.equal(memories.deleteMemory(name.id), false);
});

test("rejects untrusted or internally ambiguous memory exports", () => {
  assert.throws(() => memories.parseMemoryExport({ version: 1, exportedAt: "bad", memories: [] }), /supported/);
  assert.throws(() => memories.parseMemoryExport({
    version: 1,
    exportedAt: "2026-08-01T00:00:00.000Z",
    memories: [{ id: "x", content: "Secret", kind: "fact", origin: "inferred", confidence: 0.4 }],
  }), /user-approved provenance/);
  assert.throws(() => memories.applyMemoryImport({ version: 1, exportedAt: "2026-08-01T00:00:00.000Z", memories: [] }, ["not-reviewed"]), /no longer matches/);
});
