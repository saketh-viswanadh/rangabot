import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { compileResolvedAdvancedAnalyticalPlan, groundAdvancedAnalyticalFilters } from "../lib/analytical-filter-grounding.ts";
import type { AdvancedAnalyticalPlan } from "../lib/advanced-analytical-plan.ts";
import { inspectDatasetSchema } from "../lib/sql-runtime.ts";

const databasePath = resolve("data/filter-grounding-test.duckdb");

async function fixture() {
  if (existsSync(databasePath)) rmSync(databasePath);
  const instance = await DuckDBInstance.create(databasePath);
  const connection = await instance.connect();
  try {
    await connection.run(`
      CREATE TABLE people(person_id INTEGER, display_name VARCHAR, division VARCHAR);
      INSERT INTO people VALUES (1, 'Ada', 'North'), (2, 'Lin', 'Shared');
      CREATE TABLE topics(topic_id INTEGER, label VARCHAR, family VARCHAR);
      INSERT INTO topics VALUES (1, 'Robotics', 'Applied'), (2, 'Shared', 'Theory');
      CREATE TABLE sessions(session_id INTEGER, opened_at TIMESTAMP, closed_at TIMESTAMP);
      INSERT INTO sessions VALUES (1, TIMESTAMP '2026-01-01 09:00:00', TIMESTAMP '2026-01-01 10:00:00');
    `);
  } finally { connection.closeSync(); instance.closeSync(); }
  return inspectDatasetSchema(databasePath);
}

function plan(value: string): AdvancedAnalyticalPlan {
  return {
    action: "query", operation: "distinct_count", source: "people", metric: "", secondaryMetric: "", entity: "people.person_id",
    groupField: "", innerAggregate: "count", outerAggregate: "avg", distinct: true, dimensions: [], startField: "", endField: "", dateField: "", relatedField: "",
    filters: [{ column: "people.display_name", operator: "eq", value }], numeratorFilters: [], denominatorFilters: [], threshold: 0, decimals: 0,
    firstStart: "", firstEnd: "", secondStart: "", secondEnd: "", explanation: "Count the requested population.",
  };
}

test("grounds explicit categorical filters in approved local values", async () => {
  const columns = await fixture();
  const repaired = await groundAdvancedAnalyticalFilters(plan("Robotics"), "How many people used Robotics?", columns, databasePath);
  assert.equal(repaired.plan.filters[0]?.column, "topics.label");
  assert.equal(repaired.decisions[0]?.action, "replaced");

  const missing = plan("Robotics");
  missing.filters = [];
  const added = await groundAdvancedAnalyticalFilters(missing, "How many people used Robotics?", columns, databasePath);
  assert.deepEqual(added.plan.filters, [{ column: "topics.label", operator: "eq", value: "Robotics" }]);
  assert.ok(added.decisions.some((decision) => decision.action === "added"));

  const absent = await groundAdvancedAnalyticalFilters(plan("Unseen"), "How many people used Unseen?", columns, databasePath);
  assert.equal(absent.plan.action, "query");
  assert.equal(absent.plan.filters[0]?.column, "people.display_name");

  const ambiguous = await groundAdvancedAnalyticalFilters(plan("Shared"), "How many people used Shared?", columns, databasePath);
  assert.equal(ambiguous.plan.action, "clarify");
  assert.match(ambiguous.plan.explanation, /multiple fields/i);
  rmSync(databasePath, { force: true });
});

test("compiles fully resolved requests without a model plan", async () => {
  const columns = await fixture();
  const resolved = await compileResolvedAdvancedAnalyticalPlan("What is the average duration between opened at and closed at in hours?", columns, databasePath);
  assert.equal(resolved?.plan.operation, "duration_average");
  assert.match(resolved?.proposal.query ?? "", /DATE_DIFF\('minute', "sessions"\."opened_at", "sessions"\."closed_at"\)/);
  const ambiguous = await compileResolvedAdvancedAnalyticalPlan("What is the average duration?", columns, databasePath);
  assert.equal(ambiguous, null);
  rmSync(databasePath, { force: true });
});
