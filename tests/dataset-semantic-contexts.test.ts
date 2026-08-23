import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getDatasetSemanticMemory,
  recordDatasetSemanticUsage,
  resetDatasetSemanticContextRegistryPathForTests,
  saveDatasetSemanticMemory,
  selectDatasetSemanticContext,
  setDatasetSemanticContextRegistryPathForTests,
  verifiedSqlUsage,
} from "../lib/dataset-semantic-contexts.ts";
import type { ApprovedDataset } from "../lib/datasets.ts";
import type { DatasetColumn } from "../lib/sql-runtime.ts";

const columns: DatasetColumn[] = [
  { table: "customers", name: "customer_id", type: "INTEGER", primaryKey: true },
  { table: "customers", name: "region", type: "VARCHAR" },
  { table: "orders", name: "customer_id", type: "INTEGER" },
  { table: "orders", name: "booked_value", type: "DOUBLE" },
  { table: "orders", name: "ordered_at", type: "DATE" },
];

function dataset(sha = "a".repeat(64)): ApprovedDataset {
  return {
    id: "dataset-a", name: "sales.duckdb", path: "/private/sales.duckdb", format: "duckdb", sizeBytes: 1_024,
    addedAt: "2026-08-23T00:00:00.000Z", approvalVersion: 2,
    fileIdentity: { device: "1", inode: "2", sizeBytes: 1_024, modifiedNs: "3", changedNs: "4", sha256: sha },
  };
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "rangabot-semantic-memory-"));
  const path = join(root, "dataset-semantic-contexts.json");
  setDatasetSemanticContextRegistryPathForTests(path);
  return { root, path, cleanup() { resetDatasetSemanticContextRegistryPathForTests(); rmSync(root, { recursive: true, force: true }); } };
}

test("saves optional semantic onboarding privately and binds it to the exact dataset digest", () => {
  const fixture = sandbox();
  try {
    const saved = saveDatasetSemanticMemory({
      dataset: dataset(), columns, status: "complete",
      context: {
        version: 1,
        tables: [{ table: "orders", aliases: ["purchases"], description: "One row per customer order." }],
        columns: [{ table: "orders", column: "booked_value", aliases: ["revenue"], description: "Booked order value." }],
        relationships: [{ fromTable: "orders", fromColumn: "customer_id", toTable: "customers", toColumn: "customer_id", confirmed: true }],
        queryEvidence: "This request-only evidence must never persist.",
      },
    });
    assert.equal(saved.context.queryEvidence, undefined);
    assert.deepEqual(getDatasetSemanticMemory(dataset())?.context, saved.context);
    assert.equal(getDatasetSemanticMemory(dataset("b".repeat(64))), null);
    assert.doesNotMatch(readFileSync(fixture.path, "utf8"), /request-only evidence/);
    if (process.platform !== "win32") assert.equal(lstatSync(fixture.path).mode & 0o777, 0o600);
  } finally { fixture.cleanup(); }
});

test("rejects context outside the approved schema and does not follow a linked store", { skip: process.platform === "win32" }, () => {
  const fixture = sandbox();
  try {
    assert.throws(() => saveDatasetSemanticMemory({ dataset: dataset(), columns, status: "complete", context: { version: 1, columns: [{ table: "orders", column: "secret", description: "No." }] } }), /not in the approved schema/);
    const victim = join(fixture.root, "victim.json");
    writeFileSync(victim, JSON.stringify({ version: 1, memories: [] }), { mode: 0o600 });
    symlinkSync(victim, fixture.path);
    assert.throws(() => getDatasetSemanticMemory(dataset()), /context store is damaged/);
    assert.equal(readFileSync(victim, "utf8"), JSON.stringify({ version: 1, memories: [] }));
  } finally { fixture.cleanup(); }
});

test("retrieves a compact request-relevant slice and learns priority only from verified SQL usage", () => {
  const fixture = sandbox();
  try {
    saveDatasetSemanticMemory({
      dataset: dataset(), columns, status: "complete",
      context: {
        version: 1,
        tables: [{ table: "orders", aliases: ["purchases"] }, { table: "customers", aliases: ["clients"] }],
        columns: [
          { table: "orders", column: "booked_value", aliases: ["revenue"] },
          { table: "customers", column: "region", aliases: ["territory"] },
          { table: "orders", column: "ordered_at", aliases: ["purchase date"] },
        ],
        relationships: [{ fromTable: "orders", fromColumn: "customer_id", toTable: "customers", toColumn: "customer_id", confirmed: true }],
      },
    });
    const focused = selectDatasetSemanticContext("Show revenue by client territory", getDatasetSemanticMemory(dataset()));
    assert.deepEqual(focused?.columns?.map((item) => `${item.table}.${item.column}`).sort(), ["customers.region", "orders.booked_value"]);
    assert.equal(focused?.relationships?.length, 1);

    const usage = verifiedSqlUsage("SELECT c.region, SUM(o.booked_value) FROM customers c JOIN orders o ON o.customer_id = c.customer_id GROUP BY c.region", columns);
    assert.deepEqual(usage.tables, ["customers", "orders"]);
    assert.deepEqual(usage.columns, ["customers.customer_id", "customers.region", "orders.booked_value", "orders.customer_id"]);
    assert.equal(recordDatasetSemanticUsage(dataset(), usage), true);
    const learned = getDatasetSemanticMemory(dataset());
    assert.equal(learned?.usage.tables.orders.count, 1);
    assert.equal(learned?.usage.columns["orders.booked_value"].count, 1);
    const fallback = selectDatasetSemanticContext("Please investigate this", learned);
    assert.ok((fallback?.tables?.length ?? 0) > 0);
  } finally { fixture.cleanup(); }
});

test("skipped onboarding is remembered without sending semantic context to the model", () => {
  const fixture = sandbox();
  try {
    saveDatasetSemanticMemory({ dataset: dataset(), columns, status: "skipped", context: { version: 1 } });
    assert.equal(getDatasetSemanticMemory(dataset())?.status, "skipped");
    assert.equal(selectDatasetSemanticContext("show revenue", getDatasetSemanticMemory(dataset())), undefined);
    assert.equal(recordDatasetSemanticUsage(dataset(), { tables: ["orders"], columns: [] }), false);
  } finally { fixture.cleanup(); }
});

test("single-file queries learn the stable dataset table and unqualified columns", () => {
  assert.deepEqual(verifiedSqlUsage("SELECT region, SUM(amount) FROM dataset GROUP BY region", [
    { name: "region", type: "VARCHAR" }, { name: "amount", type: "DOUBLE" },
  ]), { tables: ["dataset"], columns: ["dataset.amount", "dataset.region"] });
});

test("the workspace and API expose optional local context without exposing file identity", () => {
  const panel = readFileSync(new URL("../app/components/sql-analysis-panel.tsx", import.meta.url), "utf8");
  const route = readFileSync(new URL("../app/api/datasets/[id]/context/route.ts", import.meta.url), "utf8");
  assert.match(panel, /Teach Ranga about this data/);
  assert.match(panel, /never invents or silently changes their meaning/);
  assert.match(route, /dataset semantic context update/);
  assert.doesNotMatch(route, /fileIdentity:\s*value\.dataset\.fileIdentity/);
});
