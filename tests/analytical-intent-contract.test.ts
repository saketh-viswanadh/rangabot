import assert from "node:assert/strict";
import test from "node:test";
import { auditAnalyticalIntent, expectedAnalyticalIntent } from "../lib/analytical-intent-contract.ts";
import type { AdvancedAnalyticalPlan } from "../lib/advanced-analytical-plan.ts";
import type { GeneralSqlPlan } from "../lib/general-sql-plan.ts";

function advanced(operation: AdvancedAnalyticalPlan["operation"]) {
  return { kind: "advanced" as const, plan: { action: "query", operation } as AdvancedAnalyticalPlan };
}

function general(overrides: Partial<GeneralSqlPlan> = {}) {
  return { kind: "general" as const, plan: { action: "query", source: "events", dimensions: [], filters: [], aggregates: [], windows: [], having: [], qualify: [], orderBy: [], limit: 0, explanation: "test", ...overrides } as GeneralSqlPlan };
}

test("classifies protected relational operation shapes", () => {
  assert.equal(expectedAnalyticalIntent("Calculate the approved rate across every row in events."), "conditional-rate");
  assert.equal(expectedAnalyticalIntent("Which team IDs have no related events?"), "missing-relationships");
  assert.equal(expectedAnalyticalIntent("List every team including zero activity with total value."), "complete-population-sum");
  assert.equal(expectedAnalyticalIntent("What is the average of each team's total value?"), "per-entity-average");
  assert.equal(expectedAnalyticalIntent("Within every region return the top 2 teams by total value."), "partitioned-top-n");
});

test("rejects plausible plans with the wrong semantic postcondition", () => {
  assert.equal(auditAnalyticalIntent("What percentage of all events are approved?", { kind: "basic", plan: { action: "query" } as never }).valid, false);
  assert.equal(auditAnalyticalIntent("Which team IDs have no related events?", advanced("distinct_count")).valid, false);
  assert.equal(auditAnalyticalIntent("Within every region return the top 2 teams by total value.", general({ limit: 2, orderBy: [{ field: "metric_1", direction: "desc" }] })).valid, false);
});

test("accepts only the compiler-owned matching shapes", () => {
  assert.equal(auditAnalyticalIntent("Calculate the approved rate across every row in events.", advanced("conditional_rate")).valid, true);
  assert.equal(auditAnalyticalIntent("Which team IDs have no related events?", advanced("anti_join")).valid, true);
  assert.equal(auditAnalyticalIntent("List every team including zero activity with total value.", advanced("complete_filtered_sum")).valid, true);
  assert.equal(auditAnalyticalIntent("What is the average of each team's total value?", advanced("per_entity_average")).valid, true);
  assert.equal(auditAnalyticalIntent("Within every region return the top 2 teams by total value.", general({
    windows: [{ slot: "window_1", function: "row_number", input: "", partitionBy: ["teams.region"], orderBy: [{ field: "metric_1", direction: "desc" }], frameRows: 0 }],
    qualify: [{ window: "window_1", operator: "lte", value: 2 }],
  })).valid, true);
});

test("distinguishes target attainment from a conditional population rate", () => {
  assert.equal(expectedAnalyticalIntent("Compare total revenue with monthly target and show attainment as a percentage."), "target-attainment");
  assert.equal(auditAnalyticalIntent("Compare total revenue with monthly target and show attainment as a percentage.", advanced("target_attainment")).valid, true);
});
