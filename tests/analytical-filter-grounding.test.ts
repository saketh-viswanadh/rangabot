import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { compileResolvedAdvancedAnalyticalPlan, groundAdvancedAnalyticalFilters } from "../lib/analytical-filter-grounding.ts";
import type { AdvancedAnalyticalPlan } from "../lib/advanced-analytical-plan.ts";
import { inspectDatasetSchema } from "../lib/sql-runtime.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rangabot-filter-grounding-"));
  const databasePath = join(root, "fixture.duckdb");
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
      CREATE TABLE entries(entry_id INTEGER, outcome VARCHAR);
      INSERT INTO entries VALUES (1, 'Complete'), (2, 'Pending'), (3, 'Complete');
      CREATE TABLE entry_logs(log_id INTEGER, entry_id INTEGER, detail VARCHAR);
      INSERT INTO entry_logs VALUES (1, 1, 'Complete');
      CREATE TABLE members(member_id INTEGER, tier VARCHAR, status VARCHAR, active BOOLEAN);
      INSERT INTO members VALUES (1, 'Gold', 'Complete', TRUE), (2, 'Gold', 'Pending', FALSE), (3, 'Silver', 'Complete', TRUE);
      CREATE TABLE shipments(shipment_id INTEGER, hub_id INTEGER, shipped_on DATE, weight DOUBLE);
      INSERT INTO shipments VALUES (1, 1, DATE '2026-04-01', 10), (2, 1, DATE '2026-05-01', 12);
      CREATE TABLE orders(order_id INTEGER, status VARCHAR);
      INSERT INTO orders VALUES (1, 'shipped');
      CHECKPOINT;
    `);
  } finally { connection.closeSync(); instance.closeSync(); }
  return { columns: await inspectDatasetSchema(databasePath), databasePath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
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
  const { columns, databasePath, cleanup } = await fixture();
  try {
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
  } finally { cleanup(); }
});

test("compiles fully resolved requests without a model plan", async () => {
  const { columns, databasePath, cleanup } = await fixture();
  try {
    const resolved = await compileResolvedAdvancedAnalyticalPlan("What is the average duration between opened at and closed at in hours?", columns, databasePath);
    assert.equal(resolved?.plan.operation, "duration_average");
    assert.match(resolved?.proposal.query ?? "", /DATE_DIFF\('minute', "sessions"\."opened_at", "sessions"\."closed_at"\)/);
    const ambiguous = await compileResolvedAdvancedAnalyticalPlan("What is the average duration?", columns, databasePath);
    assert.equal(ambiguous, null);

    const rate = await compileResolvedAdvancedAnalyticalPlan("What percentage of entries have Complete outcome?", columns, databasePath);
    assert.equal(rate?.plan.operation, "conditional_rate");
    assert.equal(rate?.plan.source, "entries");
    assert.deepEqual(rate?.plan.numeratorFilters, [{ column: "entries.outcome", operator: "eq", value: "Complete" }]);
    assert.deepEqual(rate?.plan.denominatorFilters, []);
    assert.match(rate?.proposal.query ?? "", /COUNT\(\*\) FILTER \(WHERE "entries"\."outcome" = 'Complete'\)/);

    const booleanRate = await compileResolvedAdvancedAnalyticalPlan("What percentage of members are active?", columns, databasePath);
    assert.equal(booleanRate?.plan.operation, "conditional_rate");
    assert.deepEqual(booleanRate?.plan.numeratorFilters, [{ column: "members.active", operator: "eq", value: "true" }]);
    assert.match(booleanRate?.proposal.query ?? "", /COUNT\(\*\) FILTER \(WHERE "members"\."active" = TRUE\)/);

    for (const request of [
      "What percentage of members are active or inactive?",
      "What percentage of members are active and inactive?",
      "What percentage of members are active/inactive?",
    ]) {
      const booleanAlternative = await compileResolvedAdvancedAnalyticalPlan(request, columns, databasePath);
      assert.equal(booleanAlternative?.plan.action, "clarify");
      assert.equal(booleanAlternative?.proposal.query, "");
    }

    const crossRelation = await compileResolvedAdvancedAnalyticalPlan("What percentage of entries have Robotics outcome?", columns, databasePath);
    assert.equal(crossRelation?.plan.action, "clarify");
    assert.equal(crossRelation?.proposal.query, "");

    const scoped = await compileResolvedAdvancedAnalyticalPlan("What percentage of non Complete entries have Pending outcome?", columns, databasePath);
    assert.equal(scoped, null);

    const schemaLinked = await compileResolvedAdvancedAnalyticalPlan("Calculate growth in weight from April 2026 to May 2026 using shipped_on.", columns, databasePath);
    assert.equal(schemaLinked?.plan.source, "shipments");
    assert.deepEqual(schemaLinked?.plan.filters, []);
    assert.doesNotMatch(schemaLinked?.proposal.query ?? "", /orders|status = 'shipped'/i);
  } finally { cleanup(); }
});

test("does not reinterpret already assigned numerator and denominator values", async () => {
  const { columns, databasePath, cleanup } = await fixture();
  try {
    const rate: AdvancedAnalyticalPlan = {
      ...plan(""), operation: "conditional_rate", source: "members", entity: "", filters: [],
      numeratorFilters: [{ column: "members.status", operator: "eq", value: "Complete" }],
      denominatorFilters: [{ column: "members.tier", operator: "eq", value: "Gold" }], decimals: 2,
    };
    const grounded = await groundAdvancedAnalyticalFilters(rate, "Among Gold members, what percentage have Complete status?", columns, databasePath);
    assert.equal(grounded.plan.action, "query");
    assert.deepEqual(grounded.plan.numeratorFilters, rate.numeratorFilters);
    assert.deepEqual(grounded.plan.denominatorFilters, rate.denominatorFilters);
  } finally { cleanup(); }
});

test("routes every categorical grounding read through the authorized executor", async () => {
  const columns = [
    { table: "people", name: "person_id", type: "INTEGER" },
    { table: "people", name: "display_name", type: "VARCHAR" },
    { table: "topics", name: "label", type: "VARCHAR" },
  ];
  const queries: string[] = [];
  const grounded = await groundAdvancedAnalyticalFilters(plan("Robotics"), "How many people used Robotics?", columns, "/must-not-be-opened.duckdb", async (query) => {
    queries.push(query);
    const rows = query.includes('AS "value"') ? [["topics.label", "Robotics"]] : [["topics.label"]];
    return { columns: [], rows, receipt: { engine: "duckdb", input: { filename: "approved.duckdb", sha256: "a".repeat(64), sizeBytes: 1 }, querySha256: "b".repeat(64), readOnly: true, externalAccess: false, rowLimit: 200, returnedRows: rows.length, truncated: false, durationMs: 1 } };
  });
  assert.ok(queries.length >= 1);
  assert.equal(grounded.plan.filters[0]?.column, "topics.label");
});

test("does not rediscover categorical values for fully typed non-categorical operations", async () => {
  const columns = [
    { table: "entities", name: "entity_id", type: "INTEGER" },
    { table: "events", name: "event_id", type: "INTEGER" },
    { table: "events", name: "entity_id", type: "INTEGER" },
    { table: "events", name: "occurred_on", type: "DATE" },
    { table: "events", name: "amount", type: "DOUBLE" },
    { table: "events", name: "status", type: "VARCHAR" },
    { table: "events", name: "is_completed", type: "BOOLEAN" },
  ];
  const failOnRead = async () => { throw new Error("categorical discovery must not run"); };
  const latest: AdvancedAnalyticalPlan = {
    ...plan(""), operation: "latest_per_group", source: "events", metric: "", entity: "events.event_id",
    groupField: "events.entity_id", dateField: "events.occurred_on", filters: [],
  };
  assert.equal((await groundAdvancedAnalyticalFilters(latest, "Latest event per entity using occurred on.", columns, "/unused", failOnRead)).plan.action, "query");
  const complete: AdvancedAnalyticalPlan = {
    ...plan(""), operation: "complete_filtered_sum", source: "events", metric: "events.amount", entity: "entities.entity_id",
    groupField: "events.entity_id", filters: [], numeratorFilters: [{ column: "events.is_completed", operator: "eq", value: "true" }],
  };
  assert.equal((await groundAdvancedAnalyticalFilters(complete, "Every entity including zero with completed amount.", columns, "/unused", failOnRead)).plan.action, "query");
});

test("conditional-rate grounding fails closed when one value matches multiple source fields", async () => {
  const columns = [
    { table: "records", name: "record_id", type: "INTEGER" },
    { table: "records", name: "status", type: "VARCHAR" },
    { table: "records", name: "phase", type: "VARCHAR" },
  ];
  const rate: AdvancedAnalyticalPlan = {
    ...plan("Complete"), operation: "conditional_rate", source: "records", entity: "", filters: [], numeratorFilters: [], decimals: 2,
  };
  const grounded = await groundAdvancedAnalyticalFilters(rate, "What percentage of records have Complete status?", columns, "/must-not-be-opened.duckdb", async () => {
    const rows = [["records.status", "Complete"], ["records.phase", "Complete"]];
    return { columns: [], rows, receipt: { engine: "duckdb", input: { filename: "approved.duckdb", sha256: "a".repeat(64), sizeBytes: 1 }, querySha256: "b".repeat(64), readOnly: true, externalAccess: false, rowLimit: 200, returnedRows: rows.length, truncated: false, durationMs: 1 } };
  });
  assert.equal(grounded.plan.action, "clarify");
  assert.match(grounded.plan.explanation, /multiple fields/i);
});
