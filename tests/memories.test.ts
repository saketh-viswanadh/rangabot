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
