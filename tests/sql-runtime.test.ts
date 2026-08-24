import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { executeReadOnlySql, inspectDatasetIdentity, inspectDatasetSchema, SqlRuntimeError, validateApprovedDataset } from "../lib/sql-runtime.ts";

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

test("fails visibly when SQL result dimensions or values exceed transfer budgets", async (context) => {
  const path = fixture("resource-limits.csv", "value\n1\n");
  const isResourceLimit = (error: unknown) => error instanceof SqlRuntimeError && error.code === "resource-limit";

  await context.test("column count", async () => {
    const columns = Array.from({ length: 65 }, (_, index) => `${index} AS c${index}`).join(", ");
    await assert.rejects(() => executeReadOnlySql({ approvedDatasetPath: path, query: `SELECT ${columns}` }), isResourceLimit);
  });
  await context.test("string cell", async () => {
    await assert.rejects(() => executeReadOnlySql({ approvedDatasetPath: path, query: "SELECT repeat('x', 70000) AS payload" }), isResourceLimit);
  });
  await context.test("blob cell", async () => {
    await assert.rejects(() => executeReadOnlySql({ approvedDatasetPath: path, query: "SELECT CAST(repeat('x', 70000) AS BLOB) AS payload" }), isResourceLimit);
  });
  await context.test("total result bytes", async () => {
    await assert.rejects(() => executeReadOnlySql({ approvedDatasetPath: path, query: "SELECT repeat('x', 6000) AS payload FROM range(200)" }), isResourceLimit);
  });
});

test("fails visibly instead of silently hiding a schema beyond its column budget", async () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-wide-schema-"));
  const path = join(root, "wide.duckdb");
  const writer = await DuckDBInstance.create(path);
  const connection = await writer.connect();
  try {
    const columns = Array.from({ length: 501 }, (_, index) => `c${index} INTEGER`).join(", ");
    await connection.run(`CREATE TABLE wide (${columns})`);
  } finally {
    connection.closeSync(); writer.closeSync();
  }
  try {
    await assert.rejects(
      () => inspectDatasetSchema(path),
      (error: unknown) => error instanceof SqlRuntimeError && error.code === "resource-limit",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runs the isolated SQL worker with a bounded JavaScript heap and JSON IPC", () => {
  const runtime = readFileSync(new URL("../lib/sql-runtime.ts", import.meta.url), "utf8");
  assert.match(runtime, /execArgv:\s*\[`--max-old-space-size=\$\{workerHeapMb\}`\]/);
  assert.match(runtime, /serialization:\s*"json"/);
});

test("validates the approved dataset boundary", () => {
  const unsupported = fixture("notes.txt", "secret");
  assert.throws(() => validateApprovedDataset(unsupported), /Only CSV, Parquet, and DuckDB/);
});

test("inspects only the approved dataset schema for local query planning", async () => {
  const path = fixture("schema.csv", "region,amount\nNorth,12.5\n");
  assert.deepEqual(await inspectDatasetSchema(path), [{ name: "region", type: "VARCHAR" }, { name: "amount", type: "DOUBLE" }]);
});

test("cancels identity, schema, and execution before opening the approved dataset", async () => {
  const path = fixture("cancel.csv", "value\n1\n");
  const controller = new AbortController();
  controller.abort();
  const isCancellation = (error: unknown) => error instanceof DOMException && error.name === "AbortError";
  await assert.rejects(() => inspectDatasetIdentity(path, { signal: controller.signal }), isCancellation);
  await assert.rejects(() => inspectDatasetSchema(path, { signal: controller.signal }), isCancellation);
  await assert.rejects(() => executeReadOnlySql({ approvedDatasetPath: path, query: "SELECT * FROM dataset", signal: controller.signal }), isCancellation);
});

test("interrupts an in-flight DuckDB query when the user stops generation", async () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-interrupt-"));
  const path = join(root, "interrupt.duckdb");
  const writer = await DuckDBInstance.create(path);
  writer.closeSync();
  try {
    const controller = new AbortController();
    let queryStarted = false;
    const execution = executeReadOnlySql({
      approvedDatasetPath: path,
      query: "SELECT SUM(i) FROM range(1000000000) t(i)",
      signal: controller.signal,
      timeoutMs: 30_000,
      onQueryStart: () => { queryStarted = true; controller.abort(); },
    });
    await assert.rejects(execution, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
    assert.equal(queryStarted, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interrupts and cleans up a DuckDB query at the absolute SQL timeout", async () => {
  const path = fixture("timeout.csv", "value\n1\n");
  await assert.rejects(
    () => executeReadOnlySql({ approvedDatasetPath: path, query: "SELECT SUM(i) FROM range(1000000000) t(i)", timeoutMs: 100 }),
    (error: unknown) => error instanceof SqlRuntimeError && error.code === "timeout",
  );
});

test("inspects and joins an approved multi-table DuckDB database read only", async () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-duckdb-"));
  const path = join(root, "shop.duckdb");
  const writer = await DuckDBInstance.create(path);
  const connection = await writer.connect();
  try {
    await connection.run("CREATE TABLE customers (customer_id INTEGER, name VARCHAR)");
    await connection.run("CREATE TABLE orders (order_id INTEGER, customer_id INTEGER, amount DOUBLE)");
    await connection.run("INSERT INTO customers VALUES (1, 'Asha'), (2, 'Ben')");
    await connection.run("INSERT INTO orders VALUES (10, 1, 25), (11, 1, 15), (12, 2, 7)");
  } finally {
    connection.closeSync(); writer.closeSync();
  }
  try {
    assert.deepEqual(await inspectDatasetSchema(path), [
      { table: "customers", name: "customer_id", type: "INTEGER" },
      { table: "customers", name: "name", type: "VARCHAR" },
      { table: "orders", name: "order_id", type: "INTEGER" },
      { table: "orders", name: "customer_id", type: "INTEGER" },
      { table: "orders", name: "amount", type: "DOUBLE" },
    ]);
    const result = await executeReadOnlySql({ approvedDatasetPath: path, query: "SELECT c.name, sum(o.amount) AS total FROM customers c JOIN orders o USING (customer_id) GROUP BY c.name ORDER BY c.name" });
    assert.deepEqual(result.rows, [["Asha", 40], ["Ben", 7]]);
    await assert.rejects(() => executeReadOnlySql({ approvedDatasetPath: path, query: "CREATE TABLE stolen AS SELECT * FROM customers" }), /read-only SELECT/);
    await assert.rejects(() => executeReadOnlySql({ approvedDatasetPath: path, query: `SELECT * FROM read_csv_auto('${path}.csv')` }), /external access|disabled/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exposes declared primary and foreign keys without exposing database rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-relational-schema-"));
  const path = join(root, "relationships.duckdb");
  const writer = await DuckDBInstance.create(path);
  const connection = await writer.connect();
  try {
    await connection.run("CREATE TABLE accounts (account_number INTEGER PRIMARY KEY, label VARCHAR)");
    await connection.run("CREATE TABLE payments (payment_id INTEGER PRIMARY KEY, billed_account INTEGER REFERENCES accounts(account_number), amount DOUBLE)");
  } finally {
    connection.closeSync(); writer.closeSync();
  }
  try {
    assert.deepEqual(await inspectDatasetSchema(path), [
      { table: "accounts", name: "account_number", type: "INTEGER", primaryKey: true },
      { table: "accounts", name: "label", type: "VARCHAR" },
      { table: "payments", name: "payment_id", type: "INTEGER", primaryKey: true },
      { table: "payments", name: "billed_account", type: "INTEGER", references: [{ table: "accounts", column: "account_number" }] },
      { table: "payments", name: "amount", type: "DOUBLE" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
