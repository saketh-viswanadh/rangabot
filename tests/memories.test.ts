import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import test, { after } from "node:test";
import { compileAnswerContract } from "../lib/conversation-contract.ts";

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
  assert.match(memories.formatMemoryContext("How should you explain this?") ?? "", /user-approved local memory/i);
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
  const name = memories.createMemory("My preferred name is Saketh", "fact");
  assert.equal(memories.answerDirectMemoryQuestion("What is my name?"), "Your name is Saketh. You explicitly saved that in Local memory.");
  assert.match(memories.answerDirectMemoryQuestion("What do you remember about me?") ?? "", /My preferred name is Saketh/);
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

test("selects only memories relevant to the current request", () => {
  const concise = memories.createMemory("Prefer concise answers with examples", "preference");
  const python = memories.createMemory("Use Python for data analysis", "instruction");
  const city = memories.createMemory("I live in Gurugram", "fact");

  const general = memories.buildRelevantMemoryContext("Explain database indexes");
  assert.deepEqual(general?.titles, ["Answer style"]);
  assert.match(general?.context ?? "", /concise answers/i);
  assert.doesNotMatch(general?.context ?? "", /Gurugram|Python/i);

  const technical = memories.buildRelevantMemoryContext("Help with Python data analysis");
  assert.deepEqual(technical?.titles, ["Technical preference", "Answer style"]);
  assert.match(technical?.context ?? "", /Use Python/i);
  assert.doesNotMatch(technical?.context ?? "", /Gurugram/i);

  memories.deleteMemory(concise.id);
  memories.deleteMemory(python.id);
  memories.deleteMemory(city.id);
});

test("current-turn constraints exclude conflicting approved memories", () => {
  const detailed = memories.createMemory("Always answer with detailed paragraphs", "instruction");
  const result = memories.selectRelevantMemoriesFrom(
    [detailed],
    "Reply with exactly one word: ready.",
    6,
    compileAnswerContract([{ role: "user", content: "Reply with exactly one word: ready." }]),
  );
  assert.deepEqual(result, []);
  memories.deleteMemory(detailed.id);
});

test("reviews same-purpose style memories as conflicts instead of silently stacking them", () => {
  const concise = memories.createMemory("Prefer concise answers", "preference");
  const payload = { version: 1, exportedAt: "2026-08-02T00:00:00.000Z", memories: [{ id: "long", content: "Prefer long answers", kind: "preference", origin: "user-approved", confidence: 1 }] };
  const preview = memories.previewMemoryImport(payload);
  assert.equal(preview.conflicts[0]?.reason, "same-subject");
  memories.deleteMemory(concise.id);
});

test("uses a title-only identity disclosure without leaking the saved value", () => {
  const name = memories.createMemory("My name is Saketh", "fact");
  const style = memories.createMemory("Prefer concise answers", "preference");
  const relevant = memories.buildRelevantMemoryContext("Write a short bio about me");
  assert.deepEqual(relevant?.titles, ["Preferred name", "Answer style"]);
  assert.equal(relevant?.titles.join(" ").includes("Saketh"), false);
  assert.deepEqual(memories.directMemoryTitles("What is my name?"), ["Preferred name"]);
  assert.deepEqual(memories.directMemoryTitles("What do you remember about me?"), ["Answer style", "Preferred name"]);
  memories.deleteMemory(name.id);
  memories.deleteMemory(style.id);
});
