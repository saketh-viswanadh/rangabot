import assert from "node:assert/strict";
import test from "node:test";
import { formatSqlCell } from "../lib/sql-display.ts";

test("formats local SQL result cells without hiding nulls or structures", () => {
  assert.equal(formatSqlCell(null), "null");
  assert.equal(formatSqlCell(42), "42");
  assert.equal(formatSqlCell({ verified: true }), '{"verified":true}');
});
