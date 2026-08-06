import assert from "node:assert/strict";
import test from "node:test";
import { analysisNarrationIsGrounded, auditAnalysisNarration, buildAnalysisNarrationMessages, formatVerifiedAnalysisFallback, shouldRunSqlAnalysis } from "../lib/conversational-analysis.ts";
import type { SqlExecutionResult } from "../lib/sql-runtime.ts";

const result: SqlExecutionResult = {
  columns: ["region", "total"],
  rows: [["North", "25"], ["South", "7"]],
  receipt: { engine: "duckdb", input: { filename: "sales.csv", sha256: "a".repeat(64), sizeBytes: 42 }, querySha256: "b".repeat(64), readOnly: true, externalAccess: false, rowLimit: 200, returnedRows: 2, truncated: false, durationMs: 12 },
};

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

test("grounds narration numbers in verified result values", () => {
  const context = { query: "SELECT region, SUM(revenue) AS total FROM sales GROUP BY region" };
  assert.equal(analysisNarrationIsGrounded("North is 25 and South is 7.", result, context), true);
  assert.equal(analysisNarrationIsGrounded("North is 30 and South is 7.", result), false);
  assert.equal(analysisNarrationIsGrounded("North is 25 and South is 7 across 2 rows.", result), true);
  assert.equal(analysisNarrationIsGrounded("North is 25, but the result was truncated.", result), false);
  assert.match(buildAnalysisNarrationMessages("Compare regions", { action: "query", query: "SELECT * FROM dataset", explanation: "Regional totals" }, result)[1].content, /North/);
});

test("rejects swapped labels, unsupported judgments, and causal explanations", () => {
  const context = { query: "SELECT region, SUM(revenue) AS total FROM sales GROUP BY region" };
  assert.equal(analysisNarrationIsGrounded("North is 7 and South is 25.", result, context), false);
  assert.equal(analysisNarrationIsGrounded("East is 25.", result, context), false);
  assert.equal(analysisNarrationIsGrounded("North is remarkable at 25.", result, context), false);
  assert.equal(analysisNarrationIsGrounded("North reached 25 because of South.", result, context), false);
  assert.equal(analysisNarrationIsGrounded("This result does not establish causation.", result, context), true);
});

test("verifies categorical row bindings and rankings from complete evidence", () => {
  const categorical: SqlExecutionResult = {
    ...result,
    columns: ["team", "score", "status"],
    rows: [["Alpha", 25, "High"], ["Beta", 7, "Low"]],
  };
  const context = { query: "SELECT team, score, status FROM results ORDER BY score DESC" };
  assert.equal(analysisNarrationIsGrounded("Alpha has status High at 25.", categorical, context), true);
  assert.equal(analysisNarrationIsGrounded("Alpha has status Low at 25.", categorical, context), false);
  assert.equal(analysisNarrationIsGrounded("Alpha has the highest score at 25.", categorical, context), true);
  assert.equal(analysisNarrationIsGrounded("Beta has the highest score at 7.", categorical, context), false);
  assert.equal(analysisNarrationIsGrounded("Alpha is higher than Beta.", categorical, context), true);
  assert.equal(analysisNarrationIsGrounded("Beta is higher than Alpha.", categorical, context), false);
});

test("uses only the bounded narration evidence and fails closed on limits", () => {
  const manyRows: SqlExecutionResult = {
    ...result,
    columns: ["label", "score"],
    rows: Array.from({ length: 51 }, (_, index) => [`Item ${index + 1}`, index + 1]),
    receipt: { ...result.receipt, returnedRows: 51 },
  };
  assert.equal(analysisNarrationIsGrounded("Item 51 is 51.", manyRows, { query: "SELECT label, score FROM results" }), false);
  assert.equal(analysisNarrationIsGrounded("Item 1 has the highest score at 1.", manyRows, { query: "SELECT label, score FROM results" }), false);
  assert.deepEqual(auditAnalysisNarration("x".repeat(4_001), result).failures.includes("answer-limit"), true);
});

test("falls back to a verified result table", () => {
  const answer = formatVerifiedAnalysisFallback(result);
  assert.match(answer, /\| North \| 25 \|/);
  assert.doesNotMatch(answer, /30/);
  const scalar = formatVerifiedAnalysisFallback({ ...result, columns: ["average_per_entity"], rows: [[13.33]], receipt: { ...result.receipt, returnedRows: 1 } });
  assert.equal(scalar, "The verified average per entity is **13.33**.");
});
