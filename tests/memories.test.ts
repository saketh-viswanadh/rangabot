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

test("classifies direct-memory intent without opening or creating SQLite", () => {
  assert.equal(existsSync(testDatabase), false);
  assert.equal(memories.classifyDirectMemoryRequest("What is my name?"), "preferred-name");
  assert.equal(memories.classifyDirectMemoryRequest("What do you remember about me?"), "all-memories");
  assert.equal(memories.classifyDirectMemoryRequest("Explain memory allocation."), null);
  assert.equal(existsSync(testDatabase), false);
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

test("current-turn memory opt-out selects nothing", () => {
  const preference = { id: "style", kind: "preference" as const, origin: "user-approved" as const, confidence: 1 as const, content: "Prefer concise answers", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" };
  for (const request of [
    "Do not use saved memory. Explain recursion.",
    "Ignore my local memory and explain recursion concisely.",
    "Do not use my saved preferences. Explain recursion.",
    "Ignore what you remember about me; explain recursion concisely.",
    "For this answer, forget my prior preferences and explain recursion.",
    "Use no personal context; explain recursion concisely.",
    "Could you answer without personalization?",
    "Do not use my profile. Explain recursion.",
    "Please do not personalize this answer.",
    "No personalization. Explain recursion.",
    "No personal context, please.",
    "Treat me as a new user for this answer.",
    "Do not apply saved instructions.",
    "Do not use my saved facts.",
    "Do not use stored context.",
    "Do not use what you recall about me.",
    "I don’t want you to use saved memory.",
    "Please don’t access my saved memory.",
    "Please don’t remember my preferences for this answer.",
  ]) {
    assert.equal(memories.declinesApprovedMemory(request), true, request);
    assert.deepEqual(memories.selectRelevantMemoriesFrom([preference], request), [], request);
  }
});

test("conceptual memory questions and keep directives are not treated as opt-outs", () => {
  const preference = { id: "style", kind: "preference" as const, origin: "user-approved" as const, confidence: 1 as const, content: "Prefer concise answers", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" };
  for (const request of [
    "How does saved memory work?",
    "Should I ignore saved preferences?",
    "What does personal context mean?",
    "Why might someone forget prior preferences?",
    "Can memory be ignored for one answer?",
    "Please explain why I should ignore saved preferences.",
    "Tell me whether to ignore what you remember about me.",
    "Can you explain how to answer without saved memory?",
    "Don't forget my saved preferences.",
    "Do not ignore my local memory.",
    "Translate 'ignore saved memory' into French.",
    "Quote the sentence 'Do not use saved memory'.",
    "Summarize: 'Do not use saved memory in this app.'",
    "Please explain the phrase 'do not use saved memory'.",
    "Discuss whether to ignore saved preferences.",
    "Write an essay about why people ignore saved preferences.",
    "Do not stop using saved preferences.",
    "Do not avoid using memory.",
    "Do not answer without memory.",
    "Never respond without my saved preferences.",
  ]) {
    assert.equal(memories.declinesApprovedMemory(request), false, request);
    assert.deepEqual(memories.selectRelevantMemoriesFrom([preference], request).map((memory) => memory.id), ["style"], request);
  }
});

test("the last applicable memory instruction wins without opening storage", () => {
  const preference = { id: "style", kind: "preference" as const, origin: "user-approved" as const, confidence: 1 as const, content: "Prefer concise answers", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" };
  for (const request of [
    "Use my saved memory; actually do not.",
    "Use my saved preferences; actually, no.",
    "What do you remember about me? Do not use memory.",
    "What is my name? Actually, no.",
  ]) {
    assert.equal(memories.declinesApprovedMemory(request), true, request);
    assert.deepEqual(memories.selectRelevantMemoriesFrom([preference], request), [], request);
  }
  for (const request of [
    "Do not use saved memory; actually use it.",
    "Ignore my saved preferences; actually use them.",
    "Use no saved memory; actually use my saved preferences.",
    "I don’t want you to use saved memory; actually use it.",
    "Please don’t access my saved memory; actually access it.",
    "Please don’t remember my preferences; actually remember them.",
  ]) {
    assert.equal(memories.declinesApprovedMemory(request), false, request);
    assert.deepEqual(memories.selectRelevantMemoriesFrom([preference], request).map((memory) => memory.id), ["style"], request);
  }
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

test("scopes technical preferences and recognizes related topic vocabulary", () => {
  const base = { origin: "user-approved" as const, confidence: 1 as const, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  const python = { ...base, id: "python", content: "When teaching Python, use step-by-step examples", kind: "instruction" as const };
  const spark = { ...base, id: "spark", content: "Prefer PySpark for distributed data processing", kind: "preference" as const };
  assert.deepEqual(memories.selectRelevantMemoriesFrom([python], "Explain photosynthesis"), []);
  assert.deepEqual(memories.selectRelevantMemoriesFrom([spark], "How should I reduce Spark shuffle?").map((item) => item.id), ["spark"]);
});

test("current technical choices override conflicting saved preferences", () => {
  const mysql = { id: "mysql", content: "Prefer MySQL for application databases", kind: "preference" as const, origin: "user-approved" as const, confidence: 1 as const, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  assert.deepEqual(memories.selectRelevantMemoriesFrom([mysql], "We chose PostgreSQL. Give one PostgreSQL backup command."), []);
});

test("newest same-purpose memory supersedes older entries before relevance ranking", () => {
  const base = { kind: "preference" as const, origin: "user-approved" as const, confidence: 1 as const, createdAt: "2026-01-01T00:00:00.000Z" };
  const old = { ...base, id: "old", content: "Prefer long detailed answers about indexing", updatedAt: "2026-01-01T00:00:00.000Z" };
  const current = { ...base, id: "current", content: "Prefer concise answers", updatedAt: "2026-02-01T00:00:00.000Z" };
  assert.deepEqual(memories.selectRelevantMemoriesFrom([old, current], "Explain indexing").map((item) => item.id), ["current"]);
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
