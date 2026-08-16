import { resolve } from "node:path";
import type { ChatMessage } from "../lib/providers/types.ts";
import type { LocalMemory } from "../lib/memories.ts";
import { selectRelevantMemoriesFrom } from "../lib/memories.ts";
import { buildConversationMemoryQuery } from "../lib/conversation-orchestration.ts";
import { compileAnswerContract } from "../lib/conversation-contract.ts";
import { ensurePrivateDirectory, writePrivateJsonFileAtomic } from "../lib/private-storage.ts";
import { acquireProfileMaintenanceBinding } from "../lib/profile-maintenance.ts";

const profileMaintenance = acquireProfileMaintenanceBinding({ label: "Memory selection evaluation" });

type Fixture = {
  id: string;
  memories: Array<{ id: string; content: string; kind?: LocalMemory["kind"]; updatedAt?: string }>;
  messages: ChatMessage[];
  expected: string[];
};

const suite = { name: "rangabot-memory-selection", version: "1.0.0" } as const;
const timestamp = "2026-01-01T00:00:00.000Z";
const memory = (item: Fixture["memories"][number]): LocalMemory => ({
  kind: "preference", origin: "user-approved", confidence: 1, createdAt: timestamp,
  updatedAt: item.updatedAt ?? timestamp, ...item,
});

const fixtures: Fixture[] = [
  { id: "python-scoped-style", memories: [{ id: "python", content: "When teaching Python, use step-by-step runnable examples", kind: "instruction" }, { id: "city", content: "My favorite city is Kyoto", kind: "fact" }], messages: [{ role: "user", content: "Teach me Python list comprehensions." }], expected: ["python"] },
  { id: "scoped-style-exclusion", memories: [{ id: "python", content: "When teaching Python, use step-by-step runnable examples", kind: "instruction" }], messages: [{ role: "user", content: "Explain photosynthesis." }], expected: [] },
  { id: "sql-implicit-query", memories: [{ id: "sql", content: "Use SQL for database examples", kind: "instruction" }, { id: "python", content: "Use Python for machine-learning examples", kind: "instruction" }], messages: [{ role: "user", content: "Show a tiny example that filters active users." }], expected: ["sql"] },
  { id: "sql-excluded-from-python", memories: [{ id: "sql", content: "Use SQL for database examples", kind: "instruction" }], messages: [{ role: "user", content: "Show a Python dataframe example." }], expected: [] },
  { id: "identity-recall", memories: [{ id: "name", content: "My preferred name is Saketh", kind: "fact" }], messages: [{ role: "user", content: "Greet me by my preferred name." }], expected: ["name"] },
  { id: "identity-privacy", memories: [{ id: "name", content: "My preferred name is Saketh", kind: "fact" }], messages: [{ role: "user", content: "Why is the sky blue?" }], expected: [] },
  { id: "location-relevance", memories: [{ id: "city", content: "My favorite city is Kyoto", kind: "fact" }], messages: [{ role: "user", content: "Suggest a two-day Kyoto itinerary." }], expected: ["city"] },
  { id: "health-relevance", memories: [{ id: "allergy", content: "I am allergic to peanuts", kind: "fact" }], messages: [{ role: "user", content: "Suggest a peanut-free snack." }], expected: ["allergy"] },
  { id: "health-privacy", memories: [{ id: "allergy", content: "I am allergic to peanuts", kind: "fact" }], messages: [{ role: "user", content: "Show a SQL query for product prices." }], expected: [] },
  { id: "pyspark-exact", memories: [{ id: "spark", content: "Prefer PySpark for distributed data processing", kind: "preference" }], messages: [{ role: "user", content: "Show a PySpark aggregation." }], expected: ["spark"] },
  { id: "pyspark-alias", memories: [{ id: "spark", content: "Prefer PySpark for distributed data processing", kind: "preference" }], messages: [{ role: "user", content: "How should I reduce Spark shuffle?" }], expected: ["spark"] },
  { id: "visualization-alias", memories: [{ id: "visual", content: "Prefer charts with direct labels for visualization", kind: "preference" }], messages: [{ role: "user", content: "How should I label this plot?" }], expected: ["visual"] },
  { id: "global-concision", memories: [{ id: "concise", content: "Prefer concise answers", kind: "preference" }], messages: [{ role: "user", content: "Explain database normalization." }], expected: ["concise"] },
  { id: "global-tone", memories: [{ id: "tone", content: "Use a friendly tone", kind: "instruction" }], messages: [{ role: "user", content: "Draft a reminder for my teammate." }], expected: ["tone"] },
  { id: "format-current-turn", memories: [{ id: "detail", content: "Always answer with detailed paragraphs", kind: "instruction" }], messages: [{ role: "user", content: "Reply with exactly one word: ready." }], expected: [] },
  { id: "language-current-turn", memories: [{ id: "sql", content: "Prefer SQL for code examples", kind: "preference" }], messages: [{ role: "user", content: "Use Python, not SQL, to remove duplicates." }], expected: [] },
  { id: "contextual-followup", memories: [{ id: "sql", content: "When teaching SQL, use a small table example", kind: "instruction" }], messages: [{ role: "user", content: "I want to understand SQL joins." }, { role: "assistant", content: "Let's do that." }, { role: "user", content: "Make it easy to follow." }], expected: ["sql"] },
  { id: "statistics-proficiency", memories: [{ id: "level", content: "I am a beginner in statistics", kind: "fact" }], messages: [{ role: "user", content: "Explain a p-value at my level." }], expected: ["level"] },
  { id: "address-privacy", memories: [{ id: "address", content: "My address is 42 Hidden Lane", kind: "fact" }], messages: [{ role: "user", content: "What does HTTP 404 mean?" }], expected: [] },
  { id: "database-current-choice", memories: [{ id: "mysql", content: "Prefer MySQL for application databases", kind: "preference" }], messages: [{ role: "user", content: "We chose PostgreSQL. Give one PostgreSQL backup command." }], expected: [] },
  { id: "global-step-by-step", memories: [{ id: "steps", content: "Use step-by-step explanations", kind: "instruction" }], messages: [{ role: "user", content: "Explain how rain forms." }], expected: ["steps"] },
  { id: "writing-scoped-style", memories: [{ id: "writing", content: "Use a warm tone for emails", kind: "instruction" }], messages: [{ role: "user", content: "Draft an email thanking Priya." }], expected: ["writing"] },
  { id: "writing-scoped-exclusion", memories: [{ id: "writing", content: "Use a warm tone for emails", kind: "instruction" }], messages: [{ role: "user", content: "Explain a SQL join." }], expected: [] },
  { id: "newest-same-subject", memories: [{ id: "old", content: "Prefer long answers", updatedAt: "2026-01-01T00:00:00.000Z" }, { id: "new", content: "Prefer concise answers", updatedAt: "2026-02-01T00:00:00.000Z" }], messages: [{ role: "user", content: "Explain indexing." }], expected: ["new"] },
];

let truePositive = 0;
let falsePositive = 0;
let falseNegative = 0;
const results = fixtures.map((fixture) => {
  const query = buildConversationMemoryQuery(fixture.messages);
  const selected = selectRelevantMemoriesFrom(fixture.memories.map(memory), query, 6, compileAnswerContract(fixture.messages)).map((item) => item.id);
  const expected = new Set(fixture.expected);
  const actual = new Set(selected);
  const tp = selected.filter((id) => expected.has(id)).length;
  const fp = selected.filter((id) => !expected.has(id)).length;
  const fn = fixture.expected.filter((id) => !actual.has(id)).length;
  truePositive += tp; falsePositive += fp; falseNegative += fn;
  return { id: fixture.id, expected: fixture.expected, selected, passed: fp === 0 && fn === 0, truePositive: tp, falsePositive: fp, falseNegative: fn };
});

const precision = truePositive / Math.max(1, truePositive + falsePositive);
const recall = truePositive / Math.max(1, truePositive + falseNegative);
const summary = { suite, fixtures: fixtures.length, truePositive, falsePositive, falseNegative, precision, recall, passed: precision >= 0.95 && recall >= 0.90 && results.every((result) => result.passed), results };
const outputDirectory = profileMaintenance.dataPath("evaluations", "results");
ensurePrivateDirectory(outputDirectory);
const output = resolve(outputDirectory, `memory-selection-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
profileMaintenance.assertCurrent();
writePrivateJsonFileAtomic(output, summary);
console.log(`Memory selection ${suite.version}: precision ${(precision * 100).toFixed(1)}% (${truePositive}/${truePositive + falsePositive}), recall ${(recall * 100).toFixed(1)}% (${truePositive}/${truePositive + falseNegative})`);
for (const result of results.filter((item) => !item.passed)) console.log(`FAIL ${result.id}: expected [${result.expected.join(", ")}], selected [${result.selected.join(", ")}]`);
console.log(`Private synthetic result: ${output}`);
if (!summary.passed) process.exitCode = 1;
profileMaintenance.release();
