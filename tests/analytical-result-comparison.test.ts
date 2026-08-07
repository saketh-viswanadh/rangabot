import assert from "node:assert/strict";
import test from "node:test";
import { ANALYTICAL_EVALUATION_TOLERANCE, compareSqlResults } from "../lib/analytical-result-comparison.ts";
import type { SqlExecutionResult } from "../lib/sql-runtime.ts";

function result(columns: string[], rows: unknown[][], truncated = false): SqlExecutionResult {
  return {
    columns,
    rows,
    receipt: {
      engine: "duckdb",
      input: { filename: "fixture.duckdb", sha256: "a".repeat(64), sizeBytes: 42 },
      querySha256: "b".repeat(64),
      readOnly: true,
      externalAccess: false,
      rowLimit: 200,
      returnedRows: rows.length,
      truncated,
      durationMs: 1,
    },
  };
}

const unordered = { candidateSql: "SELECT a, b FROM data", referenceSql: "SELECT a, b FROM data" };

test("compares cells by column position and preserves typed identity", () => {
  assert.equal(compareSqlResults(result(["a", "b"], [[1, 2]]), result(["x", "y"], [[2, 1]]), unordered).passed, false);
  assert.equal(compareSqlResults(result(["a"], [["001"]]), result(["x"], [[1]]), unordered).passed, false);
  assert.equal(compareSqlResults(result(["a"], [["North"]]), result(["x"], [["north"]]), unordered).passed, false);
  assert.equal(compareSqlResults(result(["a"], [["null"]]), result(["x"], [[null]]), unordered).passed, false);
  assert.equal(compareSqlResults(result(["a"], [[true]]), result(["x"], [[1]]), unordered).passed, false);
});

test("requires compatible shapes even for empty results", () => {
  assert.equal(compareSqlResults(result(["a"], []), result(["a", "b"], []), unordered).mismatch, "column-count");
  assert.equal(compareSqlResults(result(["a", "b"], [[1]]), result(["x", "y"], [[1, 2]]), unordered).mismatch, "row-width");
  assert.equal(compareSqlResults(result(["a"], [[1]]), result(["x"], [[1], [2]]), unordered).mismatch, "row-count");
});

test("uses one-to-one unordered row matching and preserves duplicates", () => {
  assert.equal(compareSqlResults(result(["a"], [[2], [1]]), result(["x"], [[1], [2]]), unordered).passed, true);
  const duplicateMismatch = compareSqlResults(result(["a"], [[1], [2]]), result(["x"], [[1], [1]]), unordered);
  assert.equal(duplicateMismatch.passed, false);
  assert.equal(duplicateMismatch.matchedRows, 1);
});

test("enforces deterministic outer ordering and ignores nested or quoted ORDER BY", () => {
  const ordered = { candidateSql: "SELECT a FROM data ORDER BY a", referenceSql: "SELECT a FROM data ORDER BY a" };
  assert.equal(compareSqlResults(result(["a"], [[2], [1]]), result(["x"], [[1], [2]]), ordered).passed, false);
  assert.equal(compareSqlResults(result(["a"], [[1], [2]]), result(["x"], [[1], [2]]), { ...ordered, candidateSql: "SELECT a FROM data" }).mismatch, "candidate-order-missing");
  assert.equal(compareSqlResults(result(["a"], [[2], [1]]), result(["x"], [[1], [2]]), {
    candidateSql: "SELECT a, 'ORDER BY' AS note FROM data",
    referenceSql: "SELECT a FROM (SELECT a FROM data ORDER BY a) nested",
  }).passed, true);
  assert.equal(compareSqlResults(result(["a"], [[1]]), result(["x"], [[1]]), {
    candidateSql: "SELECT a FROM data LIMIT 1",
    referenceSql: "SELECT a FROM data LIMIT 1",
  }).mismatch, "nondeterministic-reference");
});

test("rejects truncated results and uses strict symmetric floating tolerance", () => {
  assert.equal(compareSqlResults(result(["a"], [[1]], true), result(["x"], [[1]]), unordered).mismatch, "truncated-result");
  assert.equal(compareSqlResults(result(["a"], [[1.0000000005]]), result(["x"], [[1]]), unordered).passed, true);
  assert.equal(compareSqlResults(result(["a"], [[1.0001]]), result(["x"], [[1]]), unordered).passed, false);
  assert.equal(compareSqlResults(result(["a"], [[1.004]]), result(["x"], [[1]]), { ...unordered, ...ANALYTICAL_EVALUATION_TOLERANCE }).passed, true);
  assert.equal(compareSqlResults(result(["a"], [[1.006]]), result(["x"], [[1]]), { ...unordered, ...ANALYTICAL_EVALUATION_TOLERANCE }).passed, false);
});
