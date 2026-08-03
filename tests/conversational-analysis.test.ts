import assert from "node:assert/strict";
import test from "node:test";
import { analysisNarrationIsGrounded, buildAnalysisNarrationMessages, formatVerifiedAnalysisFallback, shouldRunSqlAnalysis } from "../lib/conversational-analysis.ts";
import type { SqlExecutionResult } from "../lib/sql-runtime.ts";

const result: SqlExecutionResult = {
  columns: ["region", "total"],
  rows: [["North", "25"], ["South", "7"]],
  receipt: { engine: "duckdb", input: { filename: "sales.csv", sha256: "a".repeat(64), sizeBytes: 42 }, querySha256: "b".repeat(64), readOnly: true, externalAccess: false, rowLimit: 200, returnedRows: 2, truncated: false, durationMs: 12 },
};

test("runs analysis for analytical requests and contextual analytical follow-ups", () => {
  assert.equal(shouldRunSqlAnalysis([{ role: "user", content: "What is the average revenue by region?" }]), true);
  assert.equal(shouldRunSqlAnalysis([{ role: "user", content: "How many customers are active?" }]), true);
  assert.equal(shouldRunSqlAnalysis([{ role: "user", content: "What was January revenue?" }]), true);
  assert.equal(shouldRunSqlAnalysis([{ role: "user", content: "Which region is best?" }]), true);
  assert.equal(shouldRunSqlAnalysis([{ role: "user", content: "What is our most valuable product?" }]), true);
  assert.equal(shouldRunSqlAnalysis([{ role: "user", content: "Compare Python and SQL for data engineering." }]), false);
  assert.equal(shouldRunSqlAnalysis([{ role: "user", content: "Compare the rows in the attached dataset." }]), true);
  assert.equal(shouldRunSqlAnalysis([{ role: "user", content: "Hello there" }]), false);
  assert.equal(shouldRunSqlAnalysis([
    { role: "assistant", content: "North leads.", analysisTrace: { engine: "duckdb", dataset: "sales.csv", query: "SELECT 1", returnedRows: 2, truncated: false, durationMs: 12, inputSha256: "a".repeat(64), querySha256: "b".repeat(64) } },
    { role: "user", content: "What about South?" },
  ]), true);
});

test("grounds narration numbers in verified result values", () => {
  assert.equal(analysisNarrationIsGrounded("North is 25 and South is 7.", result), true);
  assert.equal(analysisNarrationIsGrounded("North is 30 and South is 7.", result), false);
  assert.equal(analysisNarrationIsGrounded("North is 25, but the result was truncated.", result), false);
  assert.match(buildAnalysisNarrationMessages("Compare regions", { action: "query", query: "SELECT * FROM dataset", explanation: "Regional totals" }, result)[1].content, /North/);
});

test("falls back to a verified result table", () => {
  const answer = formatVerifiedAnalysisFallback(result);
  assert.match(answer, /\| North \| 25 \|/);
  assert.doesNotMatch(answer, /30/);
});
