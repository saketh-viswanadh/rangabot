import assert from "node:assert/strict";
import test from "node:test";
import { buildSqlProposalMessages, focusDatabaseSchema, parseSqlProposal } from "../lib/sql-proposals.ts";

test("builds a schema-bound local SQL planning prompt", () => {
  const messages = buildSqlProposalMessages([{ role: "user", content: "Total sales by region" }], { id: "d1", name: "sales.csv", path: "/private/sales.csv", format: "csv", sizeBytes: 10, addedAt: "now" }, [{ name: "region", type: "VARCHAR" }, { name: "sales", type: "DOUBLE" }]);
  assert.match(messages[1].content, /"region": VARCHAR/);
  assert.match(messages[1].content, /Total sales by region/);
  assert.doesNotMatch(messages[1].content, /private\/sales/);
});

test("accepts one read-only proposal and rejects unsafe model output", () => {
  assert.equal(parseSqlProposal('{"action":"query","query":"SELECT region, sum(sales) FROM dataset GROUP BY region","explanation":"Totals sales by region."}').query, "SELECT region, sum(sales) FROM dataset GROUP BY region");
  assert.deepEqual(parseSqlProposal('{"action":"clarify","query":"","explanation":"Which period should I use?"}'), { action: "clarify", query: "", explanation: "Which period should I use?" });
  assert.throws(() => parseSqlProposal('{"action":"query","query":"COPY dataset TO \'x.csv\'","explanation":"Exports rows."}'), /read-only SELECT/);
  assert.throws(() => parseSqlProposal('{"action":"unavailable","query":"SELECT 1","explanation":"Missing data."}'), /must not include SQL/);
});

test("builds a multi-table schema prompt without exposing the database path", () => {
  const messages = buildSqlProposalMessages([{ role: "user", content: "Revenue by customer" }], { id: "d2", name: "shop.duckdb", path: "/private/shop.duckdb", format: "duckdb", sizeBytes: 20, addedAt: "now" }, [
    { table: "customers", name: "customer_id", type: "INTEGER" },
    { table: "orders", name: "customer_id", type: "INTEGER" },
    { table: "orders", name: "revenue", type: "DOUBLE" },
  ]);
  assert.match(messages[0].content, /focused main-schema tables/i);
  assert.match(messages[1].content, /"customers"\."customer_id"/);
  assert.match(messages[1].content, /"orders"\."revenue"/);
  assert.doesNotMatch(messages[1].content, /private\/shop/);
});

const workforceSchema = [
  { table: "staff", name: "staff_id", type: "INTEGER" },
  { table: "staff", name: "team", type: "VARCHAR" },
  { table: "shifts", name: "shift_id", type: "INTEGER" },
  { table: "shifts", name: "staff_id", type: "INTEGER" },
  { table: "shifts", name: "hours", type: "DOUBLE" },
  { table: "incidents", name: "incident_id", type: "INTEGER" },
  { table: "incidents", name: "staff_id", type: "INTEGER" },
  { table: "incidents", name: "severity", type: "VARCHAR" },
];

test("focuses a database schema on relevant tables and necessary join bridges", () => {
  assert.deepEqual([...new Set(focusDatabaseSchema(workforceSchema, "total hours from shifts").map((column) => column.table))], ["shifts"]);
  assert.deepEqual(new Set(focusDatabaseSchema(workforceSchema, "shift hours by staff team").map((column) => column.table)), new Set(["staff", "shifts"]));
  assert.deepEqual(new Set(focusDatabaseSchema(workforceSchema, "incidents by staff team").map((column) => column.table)), new Set(["staff", "incidents"]));
});
