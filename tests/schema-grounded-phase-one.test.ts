import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compileAdvancedAnalyticalPlan } from "../lib/advanced-analytical-plan.ts";
import { resolveAnalyticalBoundary } from "../lib/analytical-plan.ts";
import { compileGeneralSqlPlan } from "../lib/general-sql-plan.ts";
import { buildAnalyticalSemanticCatalog, resolveSchemaGroundedPhaseOnePlan } from "../lib/schema-grounded-phase-one.ts";
import type { DatasetColumn, SqlExecutionResult } from "../lib/sql-runtime.ts";

const schema: DatasetColumn[] = [
  { table: "plans", name: "plan_id", type: "INTEGER" },
  { table: "plans", name: "group_name", type: "VARCHAR" },
  { table: "subscribers", name: "subscriber_id", type: "INTEGER" },
  { table: "subscribers", name: "plan_id", type: "INTEGER" },
  { table: "subscribers", name: "entity_name", type: "VARCHAR" },
  { table: "subscribers", name: "opened_on", type: "DATE" },
  { table: "subscribers", name: "is_active", type: "BOOLEAN" },
  { table: "subscriber_targets", name: "subscriber_id", type: "INTEGER" },
  { table: "subscriber_targets", name: "monthly_target", type: "DOUBLE" },
  { table: "renewals", name: "renewal_id", type: "INTEGER" },
  { table: "renewals", name: "subscriber_id", type: "INTEGER" },
  { table: "renewals", name: "renewed_on", type: "DATE" },
  { table: "renewals", name: "charge", type: "DOUBLE" },
  { table: "renewals", name: "seats", type: "INTEGER" },
  { table: "renewals", name: "state", type: "VARCHAR" },
  { table: "renewals", name: "is_success", type: "BOOLEAN" },
  { table: "renewals", name: "started_at", type: "TIMESTAMP" },
  { table: "renewals", name: "ended_at", type: "TIMESTAMP" },
];

function result(rows: unknown[][]): SqlExecutionResult {
  return {
    columns: ["field", "value"], rows,
    receipt: {
      engine: "duckdb", input: { filename: "fixture.duckdb", sha256: "0".repeat(64), sizeBytes: 1 }, querySha256: "0".repeat(64),
      readOnly: true, externalAccess: false, rowLimit: 200, returnedRows: rows.length, truncated: false, durationMs: 0,
    },
  };
}

const executeGrounding = async (query: string) => result(query.includes("paid") ? [["renewals.state", "paid"]] : []);

async function proposal(question: string) {
  const resolved = await resolveSchemaGroundedPhaseOnePlan(question, schema, executeGrounding);
  assert.ok(resolved, question);
  return resolved.kind === "general" ? compileGeneralSqlPlan(resolved.plan, schema) : compileAdvancedAnalyticalPlan(resolved.plan, schema);
}

test("builds a domain-neutral semantic catalogue with typed roles and aliases", () => {
  const catalog = buildAnalyticalSemanticCatalog(schema);
  assert.equal(catalog.find((item) => item.field === "renewals.charge")?.kind, "measure");
  assert.equal(catalog.find((item) => item.field === "renewals.renewed_on")?.kind, "temporal");
  assert.ok(catalog.find((item) => item.field === "renewals.charge")?.aliases.has("spending"));
});

test("grounds all Phase 1 operation shapes before SQL generation", async () => {
  const cases = [
    ["What does an average renewal look like in terms of charge?", /AVG\("renewals"\."charge"\)/],
    ["How many different subscribers appear in renewals?", /COUNT\(DISTINCT "renewals"\."subscriber_id"\)/],
    ["Show me the three biggest renewals by charge. If values tie, use the lower renewal ID first.", /ORDER BY "charge" DESC, "renewal_id" ASC LIMIT 3/],
    ["How many renewals ended up paid?", /WHERE "renewals"\."state" = 'paid'/],
    ["How much charge came from paid renewals?", /SUM\("renewals"\."charge"\)[\s\S]+WHERE "renewals"\."state" = 'paid'/],
    ["How many renewals happened during April 2025?", /"renewals"\."renewed_on" >= '2025-04-01'[\s\S]+< '2025-05-01'/],
    ["What is the middle charge when all renewals are lined up?", /MEDIAN\("renewals"\."charge"\)/],
    ["Break the renewals down by their state and show the count, alphabetically.", /GROUP BY "renewals"\."state"[\s\S]+ORDER BY "state" ASC/],
    ["For every plan name, show both total and average charge.", /SUM\("renewals"\."charge"\)[\s\S]+AVG\("renewals"\."charge"\)[\s\S]+JOIN "subscribers" USING \("subscriber_id"\)[\s\S]+JOIN "plans" USING \("plan_id"\)/],
    ["How many subscribers have at least three renewals?", /HAVING COUNT\(\*\) >= 3/],
    ["Which subscriber IDs have more than 70 in total charge? Put the largest total first.", /HAVING SUM\("renewals"\."charge"\) > 70[\s\S]+ORDER BY "metric_1" DESC, "subscriber_id" ASC/],
    ["For each renewal state, show its lowest and highest charge.", /MIN\("renewals"\."charge"\)[\s\S]+MAX\("renewals"\."charge"\)/],
  ] as const;
  for (const [question, expected] of cases) assert.match((await proposal(question)).query, expected, question);
});

test("accepts ordinary paraphrases without embedding domain vocabulary", async () => {
  assert.match((await proposal("Give the mean spending for renewals.")).query, /AVG\("renewals"\."charge"\)/);
  assert.match((await proposal("Count unique subscribers represented in renewals.")).query, /COUNT\(DISTINCT/);
  assert.match((await proposal("List the largest 3 renewals by spending, lower renewal identifier wins ties.")).query, /LIMIT 3/);
  assert.match((await proposal("Count renewals in Apr 2025.")).query, /2025-04-01/);
  assert.match((await proposal("Show the best 3 renewals by charge, lower renewal identifier wins ties.")).query, /ORDER BY "charge" DESC, "renewal_id" ASC LIMIT 3/);
});

test("grounds an explicitly named categorical table without requiring a date column", async () => {
  const categoryOnly: DatasetColumn[] = [
    { table: "orders", name: "order_id", type: "INTEGER" },
    { table: "orders", name: "status", type: "VARCHAR" },
  ];
  const resolved = await resolveSchemaGroundedPhaseOnePlan(
    "How many orders ended up approved?",
    categoryOnly,
    async () => result([["orders.status", "approved"]]),
  );
  assert.ok(resolved && resolved.kind === "general");
  assert.match(compileGeneralSqlPlan(resolved.plan, categoryOnly).query, /FROM "orders"\s+WHERE "orders"\."status" = 'approved'/);
});

test("fails closed when metric or category grounding is not unique", async () => {
  const ambiguous = [...schema, { table: "renewals", name: "net_charge", type: "DOUBLE" }];
  assert.equal(await resolveSchemaGroundedPhaseOnePlan("What is the average spending for renewals?", ambiguous, executeGrounding), null);
  assert.equal(await resolveSchemaGroundedPhaseOnePlan("Break renewals down and count them.", schema, executeGrounding), null);
});

test("routes writes, unsupported causality, relative time, and undefined ranking before planning", () => {
  assert.equal(resolveAnalyticalBoundary("Delete every cancelled renewal from the database.")?.action, "unavailable");
  assert.equal(resolveAnalyticalBoundary("Prove that plans cause higher charge.")?.action, "unavailable");
  assert.equal(resolveAnalyticalBoundary("Show recent renewals.")?.action, "clarify");
  assert.equal(resolveAnalyticalBoundary("Which subscribers perform best?")?.action, "clarify");
  assert.equal(resolveAnalyticalBoundary("Show the best 3 renewals by charge."), null);
  assert.equal(resolveAnalyticalBoundary("For each subscriber, average the current renewal and two before it."), null);
  assert.equal(resolveAnalyticalBoundary("What percentage of subscribers are currently active?"), null);
});

test("keeps grounded filters on repeat thresholds and avoids count-average overclaims", async () => {
  assert.match((await proposal("How many subscribers have at least two paid renewals?")).query, /WHERE "renewals"\."state" = 'paid'[\s\S]+HAVING COUNT\(\*\) >= 2/);
  const complete = await resolveSchemaGroundedPhaseOnePlan(
    "Across active subscribers, what is the average number of renewals, counting active ones with none as zero?",
    schema,
    executeGrounding,
  );
  assert.ok(complete && complete.kind === "advanced");
  assert.match(compileAdvancedAnalyticalPlan(complete.plan, schema).query, /AVG\("activity_count"\)[\s\S]+FROM "subscribers"[\s\S]+LEFT JOIN "renewals" ON "renewals"\."subscriber_id" = "subscribers"\."subscriber_id"[\s\S]+WHERE "subscribers"\."is_active" = TRUE/);
});

test("resolves ordinary unfiltered row counts and totals from schema roles", async () => {
  assert.match((await proposal("How many renewals do we have altogether?")).query, /COUNT\(\*\)/);
  assert.match((await proposal("What is the total charge across every renewal?")).query, /SUM\("renewals"\."charge"\)/);
});

test("resolves broader relational and temporal business operations without a model", async () => {
  assert.match((await proposal("Give me total charge for each plan name, in alphabetical order.")).query, /JOIN "subscribers" USING \("subscriber_id"\)[\s\S]+JOIN "plans" USING \("plan_id"\)[\s\S]+GROUP BY "plans"\."group_name"/);
  assert.match((await proposal("For each plan name, how many different subscribers generated activity?")).query, /COUNT\(DISTINCT "renewals"\."subscriber_id"\)[\s\S]+JOIN "subscribers" USING \("subscriber_id"\)[\s\S]+JOIN "plans" USING \("plan_id"\)/);
  assert.match((await proposal("Which subscribers have never had a renewal?")).query, /FROM "subscribers"[\s\S]+LEFT JOIN "renewals" USING \("subscriber_id"\)[\s\S]+"renewals"\."renewal_id" IS NULL/);
  assert.match((await proposal("List every subscriber, even those with no activity, and show zero when it has no paid charge.")).query, /FROM "subscribers"[\s\S]+LEFT JOIN "renewals" ON "renewals"\."subscriber_id" = "subscribers"\."subscriber_id"/);
  assert.match((await proposal("On average, how many hours passed from start to finish for a renewal?")).query, /DATE_DIFF\('minute', "renewals"\."started_at", "renewals"\."ended_at"\)/);
  assert.match((await proposal("How did total charge change in percentage terms from April 2025 to May 2025?")).query, /growth_pct/);
  assert.match((await proposal("What is the overall charge per seats, weighted by the number of seats?")).query, /SUM\("renewals"\."charge"\) \/ NULLIF\(SUM\("renewals"\."seats"\), 0\)/);
  assert.match((await proposal("Give me the newest renewal for each subscriber; if two share a date, choose the higher renewal ID.")).query, /ROW_NUMBER\(\) OVER \(PARTITION BY "renewals"\."subscriber_id" ORDER BY "renewals"\."renewed_on" DESC, "renewals"\."renewal_id" DESC\)/);
  assert.match((await proposal("What percentage of all renewals were paid?")).query, /FILTER \(WHERE "renewals"\."state" = 'paid'\)/);
  assert.match((await proposal("What is the 90th percentile for charge?")).query, /QUANTILE_CONT\("renewals"\."charge", 0\.9\)/);
  assert.match((await proposal("What is the average of each subscriber's total charge?")).query, /AVG\("entity_value"\)[\s\S]+GROUP BY "renewals"\."subscriber_id"/);
  assert.match((await proposal("Show monthly total charge and the change from the previous month.")).query, /DATE_TRUNC\('month', "renewals"\."renewed_on"\)[\s\S]+LAG\("period_value"\)/);
  assert.match((await proposal("For every subscriber, compare total charge with its monthly target and show attainment as a percentage.")).query, /attainment_pct[\s\S]+LEFT JOIN "actuals"/);
  assert.match((await proposal("Which subscribers are below their monthly charge target, and by how much? Include ones with no activity.")).query, /COALESCE\("actuals"\."actual", 0\) - "subscriber_targets"\."monthly_target" AS "variance"/);
  const ambiguousTarget = await resolveSchemaGroundedPhaseOnePlan("Which subscribers are below target, and by how much? Include ones with no activity.", schema, executeGrounding);
  assert.ok(ambiguousTarget && ambiguousTarget.kind === "advanced");
  assert.equal(ambiguousTarget.plan.action, "clarify");
  assert.equal(compileAdvancedAnalyticalPlan(ambiguousTarget.plan, schema).explanation, "Which approved actual measure should be compared with the target?");
  assert.match((await proposal("Inside each plan, which two subscribers have the highest total charge? Break ties with the lower subscriber ID.")).query, /ROW_NUMBER\(\) OVER \(PARTITION BY "group_name" ORDER BY "metric_1" DESC, "subscriber_id" ASC\)[\s\S]+"window_1" <= 2/);
});

test("production Phase 1 grounding contains no benchmark domain or value names", () => {
  const source = readFileSync(new URL("../lib/schema-grounded-phase-one.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /subscriptions|renewals|subscribers|plans|clinics|warehousing|paid|completed|delivered/);
});
