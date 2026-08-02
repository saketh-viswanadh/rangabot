import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeReadOnlySql, validateApprovedDataset } from "../lib/sql-runtime.ts";

function fixture(name: string, content: string) {
  const path = join(tmpdir(), `rangabot-${process.pid}-${name}`);
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}

test("executes a bounded read-only query and returns an inspectable receipt", async () => {
  const path = fixture("sales.csv", "category,amount\na,10\na,15\nb,7\n");
  const result = await executeReadOnlySql({ approvedDatasetPath: path, query: "SELECT category, sum(amount) AS total FROM dataset GROUP BY category ORDER BY category" });
  assert.deepEqual(result.columns, ["category", "total"]);
  assert.deepEqual(result.rows, [["a", "25"], ["b", "7"]]);
  assert.equal(result.receipt.readOnly, true);
  assert.equal(result.receipt.externalAccess, false);
  assert.equal(result.receipt.returnedRows, 2);
  assert.match(result.receipt.input.sha256, /^[a-f0-9]{64}$/);
});

test("rejects mutation, multiple statements, and post-import file access", async () => {
  const path = fixture("private.csv", "value\n1\n");
  await assert.rejects(() => executeReadOnlySql({ approvedDatasetPath: path, query: "DELETE FROM dataset" }), /read-only SELECT/);
  await assert.rejects(() => executeReadOnlySql({ approvedDatasetPath: path, query: "SELECT 1; SELECT 2" }), /one SQL statement/);
  await assert.rejects(() => executeReadOnlySql({ approvedDatasetPath: path, query: `SELECT * FROM read_csv_auto('${path.replaceAll("'", "''")}')` }), /external access|disabled/i);
});

test("caps result rows and records truncation", async () => {
  const path = fixture("bounded.csv", "value\n1\n");
  const result = await executeReadOnlySql({ approvedDatasetPath: path, query: "SELECT range AS value FROM range(250)" });
  assert.equal(result.rows.length, 200);
  assert.equal(result.receipt.truncated, true);
  assert.equal(result.receipt.rowLimit, 200);
});

test("validates the approved dataset boundary", () => {
  const unsupported = fixture("notes.txt", "secret");
  assert.throws(() => validateApprovedDataset(unsupported), /Only CSV and Parquet/);
});
