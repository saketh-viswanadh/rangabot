import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { auditAdvancedAnalyticalPlan, buildAdvancedAnalyticalMessages, buildAdvancedAnalyticalSchema, compileAdvancedAnalyticalPlan, normalizeAdvancedAnalyticalPlan, parseAdvancedAnalyticalPlan, shouldUseAdvancedAnalyticalPlan } from "../lib/advanced-analytical-plan.ts";

const schema = [
  { table: "staff", name: "staff_id", type: "INTEGER" },
  { table: "staff", name: "team", type: "VARCHAR" },
  { table: "staff", name: "active", type: "BOOLEAN" },
  { table: "shifts", name: "shift_id", type: "INTEGER" },
  { table: "shifts", name: "staff_id", type: "INTEGER" },
  { table: "shifts", name: "started_at", type: "TIMESTAMP" },
  { table: "shifts", name: "ended_at", type: "TIMESTAMP" },
  { table: "shifts", name: "hours", type: "DOUBLE" },
  { table: "shifts", name: "shift_date", type: "DATE" },
  { table: "incidents", name: "incident_id", type: "INTEGER" },
  { table: "incidents", name: "staff_id", type: "INTEGER" },
  { table: "incidents", name: "severity", type: "VARCHAR" },
];

function plan(overrides: Record<string, unknown>) {
  return parseAdvancedAnalyticalPlan(JSON.stringify({ action: "query", operation: "ratio", source: "shifts", metric: "shifts.hours", secondaryMetric: "shifts.hours", entity: "", groupField: "", innerAggregate: "count", outerAggregate: "avg", distinct: false, dimensions: [], startField: "", endField: "", dateField: "", relatedField: "", filters: [], numeratorFilters: [], denominatorFilters: [], threshold: 0, decimals: 2, firstStart: "", firstEnd: "", secondStart: "", secondEnd: "", explanation: "Verified operation.", ...overrides }));
}

test("compiles domain-neutral ratio, rate, duration and grouped operations", () => {
  assert.match(compileAdvancedAnalyticalPlan(plan({ operation: "ratio" }), schema).query, /SUM\("shifts"\."hours"\)[\s\S]*NULLIF/);
  assert.match(compileAdvancedAnalyticalPlan(plan({ operation: "conditional_rate", numeratorFilters: [{ column: "incidents.severity", operator: "eq", value: "high" }], source: "incidents" }), schema).query, /FILTER \(WHERE "incidents"\."severity" = 'high'\)/);
  assert.match(compileAdvancedAnalyticalPlan(plan({ operation: "duration_average", startField: "shifts.started_at", endField: "shifts.ended_at" }), schema).query, /DATE_DIFF\('minute'/);
  assert.match(compileAdvancedAnalyticalPlan(plan({ operation: "threshold_count", entity: "shifts.staff_id", threshold: 3 }), schema).query, /HAVING COUNT\(\*\) >= 3/);
  assert.match(compileAdvancedAnalyticalPlan(plan({ operation: "per_entity_average", entity: "shifts.staff_id" }), schema).query, /AVG\("entity_value"\)/);
});

test("compiles generic period growth and anti-join plans", () => {
  assert.match(compileAdvancedAnalyticalPlan(plan({ operation: "period_growth", dateField: "shifts.shift_date", firstStart: "2025-01-01", firstEnd: "2025-02-01", secondStart: "2025-02-01", secondEnd: "2025-03-01" }), schema).query, /growth_pct/);
  assert.match(compileAdvancedAnalyticalPlan(plan({ operation: "anti_join", source: "staff", entity: "staff.staff_id", relatedField: "shifts.staff_id", metric: "", secondaryMetric: "" }), schema).query, /LEFT JOIN "shifts" USING \("staff_id"\)/);
});

test("compiles distinct populations and aggregates over grouped values", () => {
  const distinct = normalizeAdvancedAnalyticalPlan(plan({ operation: "distinct_count", source: "incidents", entity: "incidents.staff_id", metric: "", filters: [{ column: "incidents.severity", operator: "eq", value: "high" }] }), "How many distinct staff have high severity incidents?", schema);
  assert.match(compileAdvancedAnalyticalPlan(distinct, schema).query, /COUNT\(DISTINCT "incidents"\."staff_id"\)/);

  const nested = normalizeAdvancedAnalyticalPlan(plan({ operation: "aggregate_over_groups", source: "shifts", metric: "shifts.staff_id", groupField: "staff.team", innerAggregate: "count", outerAggregate: "avg", distinct: true }), "What is the average number of distinct staff per team?", schema);
  const query = compileAdvancedAnalyticalPlan(nested, schema).query;
  assert.match(query, /COUNT\(DISTINCT "staff"\."staff_id"\)/);
  assert.match(query, /GROUP BY "staff"\."team"/);
  assert.match(query, /AVG\("group_value"\)/);
});

test("repairs an explicit grouped-count average without domain rules", () => {
  const normalized = normalizeAdvancedAnalyticalPlan(plan({
    operation: "distinct_count", source: "staff", metric: "*", entity: "staff.team",
    groupField: "staff.team", dimensions: ["staff.team"], distinct: false,
    filters: [{ column: "staff.team", operator: "eq", value: "{team}" }],
  }), "What is the average number of staff per team?", schema);
  assert.equal(normalized.operation, "aggregate_over_groups");
  assert.equal(normalized.metric, "staff.staff_id");
  assert.equal(normalized.groupField, "staff.team");
  assert.equal(normalized.innerAggregate, "count");
  assert.equal(normalized.outerAggregate, "avg");
  assert.equal(normalized.distinct, true);
  assert.deepEqual(normalized.filters, []);
});

test("unused model fields cannot alter the selected operation joins", () => {
  const query = compileAdvancedAnalyticalPlan(plan({
    operation: "distinct_count", source: "staff", entity: "staff.staff_id", metric: "shifts.hours",
    secondaryMetric: "incidents.incident_id", relatedField: "incidents.staff_id", startField: "shifts.started_at",
  }), schema).query;
  assert.match(query, /FROM "staff"/);
  assert.doesNotMatch(query, /JOIN/);
  assert.doesNotMatch(query, /incidents|shifts/);
});

test("distinct counts use the schema relation that represents the requested observation", () => {
  const normalized = normalizeAdvancedAnalyticalPlan(plan({
    operation: "distinct_count", source: "staff", entity: "staff.staff_id", metric: "shifts.staff_id",
    secondaryMetric: "shifts.shift_id", relatedField: "shifts.staff_id",
  }), "How many distinct staff worked shifts?", schema);
  assert.equal(normalized.source, "shifts");
  assert.match(compileAdvancedAnalyticalPlan(normalized, schema).query, /FROM "shifts"/);
});

test("builds its grammar only from the supplied unseen schema", () => {
  const dataset = { id: "h", name: "workforce.duckdb", path: "/private/workforce.duckdb", format: "duckdb" as const, sizeBytes: 1, addedAt: "now" };
  const messages = [{ role: "user" as const, content: "Average hours per staff member" }];
  assert.match(JSON.stringify(buildAdvancedAnalyticalSchema(messages, dataset, schema)), /shifts\.hours/);
  assert.doesNotMatch(buildAdvancedAnalyticalMessages(messages, dataset, schema)[1].content, /private\/workforce/);
});

test("production analytical planners contain no benchmark schema names", () => {
  const source = ["advanced-analytical-plan.ts", "analytical-plan.ts", "sql-proposals.ts"]
    .map((name) => readFileSync(new URL(`../lib/${name}`, import.meta.url), "utf8")).join("\n");
  for (const term of ["campaigns", "payments", "support_tickets", "order_items", "products", "customers", "orders", "staff", "shifts", "incidents", "machines", "runs", "authors", "articles", "members", "loans"]) {
    assert.doesNotMatch(source, new RegExp(`["']${term}["']|\\b${term}\\.`));
  }
  assert.equal(shouldUseAdvancedAnalyticalPlan("Average hours per staff member"), true);
});

test("removes unsupported model additions while preserving current-request evidence", () => {
  const proposed = plan({
    operation: "ratio",
    source: "staff",
    dimensions: ["shifts.hours", "staff.team"],
    filters: [
      { column: "staff.active", operator: "eq", value: "true" },
      { column: "incidents.severity", operator: "eq", value: "high" },
      { column: "shifts.hours", operator: "gt", value: "" },
    ],
  });
  const audited = auditAdvancedAnalyticalPlan(proposed, "For active staff, what is the ratio of total hours divided by total hours?", schema);
  assert.equal(audited.plan.source, "shifts");
  assert.deepEqual(audited.plan.dimensions, []);
  assert.deepEqual(audited.plan.filters, [{ column: "staff.active", operator: "eq", value: "true" }]);
  assert.ok(audited.decisions.some((decision) => decision.field === "dimensions" && decision.action === "removed"));
});

test("enforces operation contracts and asks rather than guessing", () => {
  const invalidDuration = normalizeAdvancedAnalyticalPlan(plan({ operation: "duration_average", startField: "shifts.hours", endField: "shifts.ended_at" }), "What is the average duration?", schema);
  assert.equal(invalidDuration.action, "clarify");
  assert.match(invalidDuration.explanation, /start field/i);

  const threshold = normalizeAdvancedAnalyticalPlan(plan({ operation: "threshold_count", source: "staff", entity: "shifts.staff_id", threshold: 3, filters: [{ column: "shifts.shift_id", operator: "gt", value: "3" }] }), "How many staff have at least 3 shifts?", schema);
  assert.deepEqual(threshold.filters, []);
});

test("derives valid calendar boundaries and fixes the operation source generically", () => {
  const normalized = normalizeAdvancedAnalyticalPlan(plan({
    operation: "period_growth", source: "incidents", metric: "shifts.hours", dateField: "shifts.started_at",
    firstStart: "2025-01-01", firstEnd: "2025-02-29", secondStart: "2025-02-01", secondEnd: "2025-03-31",
  }), "What was the growth in total hours from January 2025 to February 2025?", schema);
  assert.equal(normalized.source, "shifts");
  assert.equal(normalized.dateField, "shifts.shift_date");
  assert.deepEqual([normalized.firstStart, normalized.firstEnd, normalized.secondStart, normalized.secondEnd], ["2025-01-01", "2025-02-01", "2025-02-01", "2025-03-01"]);
});

test("aligns anti-joins to distinct directly related relations", () => {
  const normalized = normalizeAdvancedAnalyticalPlan(plan({ operation: "anti_join", source: "incidents", entity: "staff.staff_id", relatedField: "incidents.incident_id", metric: "", secondaryMetric: "" }), "Which staff were never matched to incidents?", schema);
  assert.equal(normalized.source, "staff");
  assert.match(compileAdvancedAnalyticalPlan(normalized, schema).query, /FROM "staff"[\s\S]*LEFT JOIN "incidents"/);
});
