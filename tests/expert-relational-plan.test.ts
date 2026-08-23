import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { compileExpertRelationalPlan, expertRelationalOutputColumns, resolveExpertRelationalPlan, shouldUseExpertRelationalPlan } from "../lib/expert-relational-plan.ts";
import { executeReadOnlySql } from "../lib/sql-runtime.ts";

const schema = [
  { table: "accounts", name: "account_id", type: "INTEGER" }, { table: "accounts", name: "segment", type: "VARCHAR" },
  { table: "events", name: "event_id", type: "INTEGER" }, { table: "events", name: "account_id", type: "INTEGER" },
  { table: "events", name: "occurred_on", type: "DATE" }, { table: "events", name: "amount", type: "DOUBLE" }, { table: "events", name: "status", type: "VARCHAR" },
];

const requests = {
  yoy: "Calculate year-over-year amount change by month.",
  cohort: "Build a cohort retention table for accounts from their first event month.",
  funnel: "Create a funnel from all events to completed events.",
  pivot: "Pivot total amount into April 2026 and May 2026 columns for every account ID.",
  union: "Union account IDs that have events with account IDs in the west segment.",
  exists: "Return account IDs where a correlated exists subquery finds an event above 20 amount.",
};

test("resolves and compiles bounded expert relational operations", () => {
  const plans = Object.fromEntries(Object.entries(requests).map(([key, request]) => [key, resolveExpertRelationalPlan(request, schema)]));
  assert.deepEqual(Object.fromEntries(Object.entries(plans).map(([key, plan]) => [key, plan?.operation])), {
    yoy: "year_over_year", cohort: "cohort_first_period", funnel: "funnel_counts", pivot: "period_pivot", union: "set_union", exists: "correlated_exists",
  });
  for (const request of Object.values(requests)) assert.equal(shouldUseExpertRelationalPlan(request), true);
  assert.match(compileExpertRelationalPlan(plans.yoy!, schema).query, /LAG\("period_value", 12\)/);
  assert.match(compileExpertRelationalPlan(plans.cohort!, schema).query, /MIN\(DATE_TRUNC\('month'/);
  assert.match(compileExpertRelationalPlan(plans.funnel!, schema).query, /FILTER \(WHERE "events"\."status" = 'completed'\)/);
  assert.match(compileExpertRelationalPlan(plans.pivot!, schema).query, /DATE '2026-04-01'.+DATE '2026-05-01'/);
  assert.match(compileExpertRelationalPlan(plans.union!, schema).query, / UNION SELECT /);
  assert.match(compileExpertRelationalPlan(plans.exists!, schema).query, /WHERE EXISTS \(SELECT 1/);
  assert.deepEqual(expertRelationalOutputColumns(plans.yoy!), ["period_month", "period_value", "yoy_change"]);
});

test("executes every expert relational operation with exact local results", async () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-expert-relational-")); const database = join(root, "fixture.duckdb");
  const instance = await DuckDBInstance.create(database); const connection = await instance.connect();
  try {
    await connection.run("CREATE TABLE accounts(account_id INTEGER,segment VARCHAR); INSERT INTO accounts VALUES (1,'west'),(2,'east'),(3,'west'); CREATE TABLE events(event_id INTEGER,account_id INTEGER,occurred_on DATE,amount DOUBLE,status VARCHAR); INSERT INTO events VALUES (1,1,'2025-04-01',10,'completed'),(2,1,'2026-04-01',30,'pending'),(3,2,'2026-04-02',20,'completed'),(4,2,'2026-05-01',40,'completed');");
  } finally { connection.closeSync(); instance.closeSync(); }
  try {
    const run = async (request: string) => executeReadOnlySql({ approvedDatasetPath: database, query: compileExpertRelationalPlan(resolveExpertRelationalPlan(request, schema)!, schema).query });
    const yoy = await run(requests.yoy); assert.deepEqual(yoy.rows[0], ["2025-04-01 00:00:00", 10, null]);
    assert.deepEqual((await run(requests.cohort)).rows, [["2025-04-01 00:00:00", "1"], ["2026-04-01 00:00:00", "1"]]);
    assert.deepEqual((await run(requests.funnel)).rows, [["4", "3"]]);
    assert.deepEqual((await run(requests.pivot)).rows, [[1, 30, null], [2, 20, 40]]);
    assert.deepEqual((await run(requests.union)).rows, [[1], [2], [3]]);
    assert.deepEqual((await run(requests.exists)).rows, [[1], [2]]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fails closed when an expert relation or measure is ambiguous", () => {
  const ambiguous = [...schema, { table: "charges", name: "charge_id", type: "INTEGER" }, { table: "charges", name: "occurred_on", type: "DATE" }, { table: "charges", name: "amount", type: "DOUBLE" }];
  assert.equal(resolveExpertRelationalPlan("Calculate year-over-year amount change by month.", ambiguous), null);
  assert.equal(resolveExpertRelationalPlan("Union account IDs.", schema), null);
  assert.equal(resolveExpertRelationalPlan("Create a funnel from all events to events.", schema), null);
});
