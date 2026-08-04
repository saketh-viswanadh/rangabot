import assert from "node:assert/strict";
import test from "node:test";
import { auditAdvancedAnalyticalPlan, normalizeAdvancedAnalyticalPlan, parseAdvancedAnalyticalPlan } from "../lib/advanced-analytical-plan.ts";
import type { DatasetColumn } from "../lib/sql-runtime.ts";

function proposed(overrides: Record<string, unknown>) {
  return parseAdvancedAnalyticalPlan(JSON.stringify({
    action: "query", operation: "ratio", source: "", metric: "", secondaryMetric: "", entity: "", groupField: "", innerAggregate: "count", outerAggregate: "avg", distinct: false, dimensions: [],
    startField: "", endField: "", dateField: "", relatedField: "", filters: [], numeratorFilters: [], denominatorFilters: [],
    threshold: 0, decimals: 2, firstStart: "", firstEnd: "", secondStart: "", secondEnd: "", explanation: "Proposed calculation.", ...overrides,
  }));
}

const manufacturing: DatasetColumn[] = [
  { table: "machines", name: "machine_id", type: "INTEGER" }, { table: "machines", name: "line", type: "VARCHAR" },
  { table: "runs", name: "run_id", type: "INTEGER" }, { table: "runs", name: "machine_id", type: "INTEGER" },
  { table: "runs", name: "started_at", type: "TIMESTAMP" }, { table: "runs", name: "finished_at", type: "TIMESTAMP" },
  { table: "runs", name: "output_kg", type: "DOUBLE" }, { table: "runs", name: "energy_kwh", type: "DOUBLE" },
  { table: "runs", name: "run_date", type: "DATE" }, { table: "runs", name: "approved", type: "BOOLEAN" },
];

const publishing: DatasetColumn[] = [
  { table: "authors", name: "author_id", type: "INTEGER" }, { table: "authors", name: "active", type: "BOOLEAN" },
  { table: "articles", name: "article_id", type: "INTEGER" }, { table: "articles", name: "author_id", type: "INTEGER" },
  { table: "articles", name: "word_count", type: "INTEGER" }, { table: "articles", name: "published_on", type: "DATE" },
  { table: "reviews", name: "review_id", type: "INTEGER" }, { table: "reviews", name: "article_id", type: "INTEGER" },
  { table: "reviews", name: "score", type: "DOUBLE" },
];

test("mutation audit removes unsupported dimensions, empty values and unrelated filters", () => {
  const audit = auditAdvancedAnalyticalPlan(proposed({
    operation: "ratio", source: "machines", metric: "runs.output_kg", secondaryMetric: "runs.energy_kwh",
    dimensions: ["machines.line", "runs.output_kg"], filters: [
      { column: "runs.output_kg", operator: "gt", value: "" },
      { column: "runs.approved", operator: "eq", value: "true" },
    ],
  }), "What is total output_kg divided by total energy_kwh?", manufacturing);
  assert.equal(audit.plan.source, "runs");
  assert.deepEqual(audit.plan.dimensions, []);
  assert.deepEqual(audit.plan.filters, []);
  assert.ok(audit.decisions.filter((decision) => decision.action === "removed").length >= 3);
});

test("current request may explicitly authorize a Boolean filter", () => {
  const plan = normalizeAdvancedAnalyticalPlan(proposed({
    operation: "ratio", source: "runs", metric: "runs.output_kg", secondaryMetric: "runs.energy_kwh",
    filters: [{ column: "runs.approved", operator: "eq", value: "false" }],
  }), "For approved runs, what is output_kg divided by energy_kwh?", manufacturing);
  assert.deepEqual(plan.filters, [{ column: "runs.approved", operator: "eq", value: "true" }]);
});

test("explicit categorical values survive without requiring database jargon", () => {
  const plan = normalizeAdvancedAnalyticalPlan(proposed({
    operation: "distinct_count", source: "articles", entity: "articles.author_id",
    filters: [{ column: "articles.topic", operator: "eq", value: "Robotics" }],
  }), "How many distinct authors published Robotics at least once?", [
    ...publishing,
    { table: "articles", name: "topic", type: "VARCHAR" },
  ]);
  assert.deepEqual(plan.filters, [{ column: "articles.topic", operator: "eq", value: "Robotics" }]);

  const unsafeNumeric = normalizeAdvancedAnalyticalPlan(proposed({
    operation: "distinct_count", source: "articles", entity: "articles.author_id",
    filters: [{ column: "articles.article_id", operator: "gte", value: "3" }],
  }), "How many distinct authors published at least 3 times?", publishing);
  assert.deepEqual(unsafeNumeric.filters, []);
});

test("invalid cross-relation duration becomes a clarification", () => {
  const plan = normalizeAdvancedAnalyticalPlan(proposed({ operation: "duration_average", source: "runs", startField: "runs.started_at", endField: "articles.published_on" }), "What is the average duration?", [...manufacturing, ...publishing]);
  assert.equal(plan.action, "clarify");
  assert.match(plan.explanation, /same approved relation/i);
});

test("period comparison uses the unique date-grain field and real month boundaries", () => {
  const plan = normalizeAdvancedAnalyticalPlan(proposed({
    operation: "period_growth", source: "machines", metric: "runs.output_kg", dateField: "runs.finished_at",
    firstStart: "2024-02-01", firstEnd: "2024-02-31", secondStart: "2024-03-01", secondEnd: "2024-03-30",
  }), "Compare output_kg growth from February 2024 to March 2024.", manufacturing);
  assert.equal(plan.source, "runs");
  assert.equal(plan.dateField, "runs.run_date");
  assert.deepEqual([plan.firstStart, plan.firstEnd, plan.secondStart, plan.secondEnd], ["2024-02-01", "2024-03-01", "2024-03-01", "2024-04-01"]);
});

test("threshold values belong to HAVING rather than invented identifier filters", () => {
  const plan = normalizeAdvancedAnalyticalPlan(proposed({
    operation: "threshold_count", source: "articles", entity: "articles.author_id", threshold: 5,
    filters: [{ column: "articles.article_id", operator: "gte", value: "5" }],
  }), "How many authors have at least 5 articles?", publishing);
  assert.deepEqual(plan.filters, []);
});

test("per-entity plans reject unrelated memory-like scope additions", () => {
  const plan = normalizeAdvancedAnalyticalPlan(proposed({
    operation: "per_entity_average", source: "authors", metric: "articles.word_count", entity: "articles.author_id",
    filters: [{ column: "authors.active", operator: "eq", value: "true" }],
  }), "What is average total word_count per author?", publishing);
  assert.equal(plan.source, "articles");
  assert.deepEqual(plan.filters, []);
});

test("anti-join plans require separate related relations", () => {
  const invalid = normalizeAdvancedAnalyticalPlan(proposed({ operation: "anti_join", source: "articles", entity: "articles.article_id", relatedField: "articles.author_id" }), "Which articles were never reviewed?", publishing);
  assert.equal(invalid.action, "clarify");
  const valid = normalizeAdvancedAnalyticalPlan(proposed({ operation: "anti_join", source: "reviews", entity: "articles.article_id", relatedField: "reviews.review_id" }), "Which articles were never reviewed?", publishing);
  assert.equal(valid.source, "articles");
});

test("conditional rates fail closed after unsupported numerator removal", () => {
  const plan = normalizeAdvancedAnalyticalPlan(proposed({
    operation: "conditional_rate", source: "reviews",
    numeratorFilters: [{ column: "reviews.score", operator: "gte", value: "4" }],
  }), "What percentage of reviews were favorable?", publishing);
  assert.equal(plan.action, "clarify");
  assert.match(plan.explanation, /numerator/i);
});
