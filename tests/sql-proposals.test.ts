import assert from "node:assert/strict";
import test from "node:test";
import { buildSqlProposalMessages, parseSqlProposal } from "../lib/sql-proposals.ts";

test("builds a schema-bound local SQL planning prompt", () => {
  const messages = buildSqlProposalMessages([{ role: "user", content: "Total sales by region" }], { id: "d1", name: "sales.csv", path: "/private/sales.csv", format: "csv", sizeBytes: 10, addedAt: "now" }, [{ name: "region", type: "VARCHAR" }, { name: "sales", type: "DOUBLE" }]);
  assert.match(messages[1].content, /"region": VARCHAR/);
  assert.match(messages[1].content, /Total sales by region/);
  assert.doesNotMatch(messages[1].content, /private\/sales/);
});

test("accepts one read-only proposal and rejects unsafe model output", () => {
  assert.equal(parseSqlProposal('{"query":"SELECT region, sum(sales) FROM dataset GROUP BY region","explanation":"Totals sales by region."}').query, "SELECT region, sum(sales) FROM dataset GROUP BY region");
  assert.throws(() => parseSqlProposal('{"query":"COPY dataset TO \'x.csv\'","explanation":"Exports rows."}'), /read-only SELECT/);
});
