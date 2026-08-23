import assert from "node:assert/strict";
import test from "node:test";
import { classifyConversationalAnalysis, shouldRunSqlAnalysis } from "../lib/conversational-analysis.ts";

test("runs analysis for analytical requests and contextual analytical follow-ups", () => {
  assert.equal(shouldRunSqlAnalysis([{ role: "user", content: "What is the average revenue by region?" }]), true);
  assert.equal(shouldRunSqlAnalysis([{ role: "user", content: "How many customers are active?" }]), true);
  assert.equal(shouldRunSqlAnalysis([{ role: "user", content: "What was total revenue in January?" }]), true);
  assert.equal(shouldRunSqlAnalysis([{ role: "user", content: "Which region is best?" }]), true);
  assert.equal(shouldRunSqlAnalysis([{ role: "user", content: "What is our most valuable product?" }]), true);
  assert.equal(shouldRunSqlAnalysis([{ role: "user", content: "Compare Python and SQL for data engineering." }]), false);
  assert.equal(shouldRunSqlAnalysis([{ role: "user", content: "Compare the rows in the attached dataset." }]), true);
  assert.equal(shouldRunSqlAnalysis([{ role: "user", content: "Tell me a little about this data." }]), true);
  assert.equal(shouldRunSqlAnalysis([{ role: "user", content: "Use the selected data." }]), true);
  assert.equal(shouldRunSqlAnalysis([{ role: "user", content: "What do you notice?" }]), true);
  assert.equal(shouldRunSqlAnalysis([{ role: "user", content: "Hello there" }]), false);
  assert.equal(shouldRunSqlAnalysis([
    { role: "assistant", content: "North leads.", analysisTrace: { engine: "duckdb", dataset: "sales.csv", query: "SELECT 1", returnedRows: 2, truncated: false, durationMs: 12, inputSha256: "a".repeat(64), querySha256: "b".repeat(64) } },
    { role: "user", content: "What about South?" },
  ]), true);
});

test("separates general calculation from requests that require an attached dataset", () => {
  assert.deepEqual(classifyConversationalAnalysis([{ role: "user", content: "Calculate 2 + 2" }]), { requested: true, requiresDataset: false, explicitlyDeclined: false });
  assert.deepEqual(classifyConversationalAnalysis([{ role: "user", content: "Count the attached rows" }]), { requested: true, requiresDataset: true, explicitlyDeclined: false });
  assert.deepEqual(classifyConversationalAnalysis([{ role: "user", content: "Explain this code; do not analyze the attached dataset" }]), { requested: false, requiresDataset: false, explicitlyDeclined: true });
});
