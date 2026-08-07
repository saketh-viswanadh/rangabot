import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { auditAdvancedAnalyticalPlan, buildAdvancedAnalyticalMessages, buildAdvancedAnalyticalSchema, compileAdvancedAnalyticalPlan, normalizeAdvancedAnalyticalPlan, parseAdvancedAnalyticalPlan, recoverAdvancedAnalyticalPlan, shouldUseAdvancedAnalyticalPlan } from "../lib/advanced-analytical-plan.ts";

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

test("uses high-confidence schema roles for grouped counts and summed measures", () => {
  const columns = [
    { table: "patients", name: "patient_id", type: "INTEGER" },
    { table: "clinicians", name: "clinician_id", type: "INTEGER" },
    { table: "appointments", name: "appointment_id", type: "INTEGER" },
    { table: "appointments", name: "patient_id", type: "INTEGER" },
    { table: "appointments", name: "clinician_id", type: "INTEGER" },
    { table: "appointments", name: "charge_amount", type: "DOUBLE" },
  ];
  const grouped = normalizeAdvancedAnalyticalPlan(plan({ operation: "distinct_count", source: "patients", entity: "patients.patient_id", groupField: "patients.patient_id", metric: "*" }), "What is the average number of appointments per clinician?", columns);
  assert.deepEqual({ operation: grouped.operation, source: grouped.source, metric: grouped.metric, group: grouped.groupField }, {
    operation: "aggregate_over_groups", source: "appointments", metric: "appointments.appointment_id", group: "appointments.clinician_id",
  });

  const summed = normalizeAdvancedAnalyticalPlan(plan({ operation: "distinct_count", source: "patients", entity: "patients.patient_id", metric: "*" }), "What is the average total charge amount per patient?", columns);
  assert.deepEqual({ operation: summed.operation, source: summed.source, metric: summed.metric, entity: summed.entity }, {
    operation: "per_entity_average", source: "appointments", metric: "appointments.charge_amount", entity: "appointments.patient_id",
  });
});

test("uses explicit temporal endpoints but does not invent absent roles", () => {
  const columns = [
    { table: "sessions", name: "session_id", type: "INTEGER" },
    { table: "sessions", name: "opened_at", type: "TIMESTAMP" },
    { table: "sessions", name: "closed_at", type: "TIMESTAMP" },
    { table: "sessions", name: "cost", type: "DOUBLE" },
  ];
  const duration = normalizeAdvancedAnalyticalPlan(plan({ operation: "per_entity_average", source: "sessions", metric: "sessions.cost", entity: "sessions.session_id" }), "What is the average duration between opened at and closed at in hours?", columns);
  assert.deepEqual({ operation: duration.operation, start: duration.startField, end: duration.endField }, {
    operation: "duration_average", start: "sessions.opened_at", end: "sessions.closed_at",
  });
  const absent = normalizeAdvancedAnalyticalPlan(plan({ operation: "per_entity_average", source: "sessions", metric: "sessions.cost", entity: "sessions.session_id" }), "What is the average total rainfall per session?", columns);
  assert.equal(absent.action, "clarify");
  assert.match(absent.explanation, /measure and entity/i);
});

test("recovers a complete high-confidence plan without trusting malformed model JSON", () => {
  const columns = [
    { table: "sessions", name: "session_id", type: "INTEGER" },
    { table: "sessions", name: "opened_at", type: "TIMESTAMP" },
    { table: "sessions", name: "closed_at", type: "TIMESTAMP" },
  ];
  const recovered = recoverAdvancedAnalyticalPlan("What is the average duration between opened at and closed at in hours?", columns);
  assert.deepEqual({ operation: recovered?.operation, source: recovered?.source, start: recovered?.startField, end: recovered?.endField }, {
    operation: "duration_average", source: "sessions", start: "sessions.opened_at", end: "sessions.closed_at",
  });
  assert.equal(recoverAdvancedAnalyticalPlan("What is the average duration?", columns), null);
});

test("resolves row-count ratios, thresholds, unmatched relations and period grains", () => {
  const columns = [
    { table: "devices", name: "device_id", type: "INTEGER" },
    { table: "readings", name: "reading_id", type: "INTEGER" },
    { table: "readings", name: "device_id", type: "INTEGER" },
    { table: "readings", name: "recorded_on", type: "DATE" },
    { table: "readings", name: "energy_kwh", type: "DOUBLE" },
    { table: "maintenance", name: "maintenance_id", type: "INTEGER" },
    { table: "maintenance", name: "device_id", type: "INTEGER" },
  ];
  const ratio = normalizeAdvancedAnalyticalPlan(plan({ operation: "ratio", source: "devices", metric: "readings.energy_kwh", secondaryMetric: "readings.energy_kwh" }), "What is the ratio of total energy kwh divided by total readings?", columns);
  assert.deepEqual({ source: ratio.source, metric: ratio.metric, secondary: ratio.secondaryMetric }, { source: "readings", metric: "readings.energy_kwh", secondary: "*" });
  assert.match(compileAdvancedAnalyticalPlan(ratio, columns).query, /SUM\("readings"\."energy_kwh"\) \/ NULLIF\(COUNT\(\*\), 0\)/);

  const threshold = normalizeAdvancedAnalyticalPlan(plan({ operation: "distinct_count", source: "devices", entity: "devices.device_id", threshold: 1 }), "How many devices have at least 3 readings?", columns);
  assert.deepEqual({ operation: threshold.operation, source: threshold.source, entity: threshold.entity, threshold: threshold.threshold }, { operation: "threshold_count", source: "readings", entity: "readings.device_id", threshold: 3 });

  const unmatched = normalizeAdvancedAnalyticalPlan(plan({ operation: "distinct_count", source: "readings", entity: "readings.reading_id", relatedField: "" }), "Which devices were never linked to maintenance?", columns);
  assert.deepEqual({ operation: unmatched.operation, source: unmatched.source, entity: unmatched.entity, related: unmatched.relatedField }, { operation: "anti_join", source: "devices", entity: "devices.device_id", related: "maintenance.maintenance_id" });

  const growth = normalizeAdvancedAnalyticalPlan(plan({ operation: "ratio", source: "devices", metric: "readings.energy_kwh", dateField: "" }), "What was the growth in total energy kwh using recorded on from January 2026 to February 2026?", columns);
  assert.deepEqual({ operation: growth.operation, source: growth.source, metric: growth.metric, date: growth.dateField }, { operation: "period_growth", source: "readings", metric: "readings.energy_kwh", date: "readings.recorded_on" });
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

test("distinct source resolution uses exact qualifying relations and grounded filters", () => {
  const columns = [
    { table: "members", name: "member_id", type: "INTEGER" },
    { table: "events", name: "event_id", type: "INTEGER" },
    { table: "events", name: "member_id", type: "INTEGER" },
    { table: "events", name: "category_id", type: "INTEGER" },
    { table: "event_runs", name: "run_id", type: "INTEGER" },
    { table: "event_runs", name: "member_id", type: "INTEGER" },
    { table: "categories", name: "category_id", type: "INTEGER" },
    { table: "categories", name: "type", type: "VARCHAR" },
  ];
  const normalized = normalizeAdvancedAnalyticalPlan(plan({
    operation: "distinct_count", source: "members", entity: "members.member_id", metric: "", secondaryMetric: "",
    filters: [{ column: "categories.type", operator: "eq", value: "Public" }],
  }), "How many distinct members attended Public events?", columns);
  assert.equal(normalized.source, "events");
  assert.equal(normalized.entity, "events.member_id");
  const reordered = normalizeAdvancedAnalyticalPlan(plan({
    operation: "distinct_count", source: "members", entity: "members.member_id", metric: "", secondaryMetric: "",
    filters: [{ column: "categories.type", operator: "eq", value: "Public" }],
  }), "How many distinct members attended Public events?", [...columns].reverse());
  assert.equal(reordered.source, "events");
});

test("distinct source resolution clarifies equal qualifying relations", () => {
  const columns = [
    { table: "members", name: "member_id", type: "INTEGER" },
    { table: "sessions", name: "session_id", type: "INTEGER" },
    { table: "sessions", name: "member_id", type: "INTEGER" },
    { table: "workshops", name: "workshop_id", type: "INTEGER" },
    { table: "workshops", name: "member_id", type: "INTEGER" },
  ];
  const normalized = normalizeAdvancedAnalyticalPlan(plan({
    operation: "distinct_count", source: "members", entity: "members.member_id", metric: "", secondaryMetric: "",
  }), "How many distinct members joined sessions and workshops?", columns);
  assert.equal(normalized.action, "clarify");
  assert.match(normalized.explanation, /relation defines/i);
});

test("distinct source resolution never defaults to the entity relation without qualifying evidence", () => {
  const columns = [
    { table: "people", name: "person_id", type: "INTEGER" },
    { table: "attendances", name: "attendance_id", type: "INTEGER" },
    { table: "attendances", name: "person_id", type: "INTEGER" },
  ];
  const normalized = normalizeAdvancedAnalyticalPlan(plan({
    operation: "distinct_count", source: "attendances", entity: "people.person_id", metric: "", secondaryMetric: "",
  }), "How many distinct people attended at least once?", columns);
  assert.equal(normalized.action, "clarify");
  assert.match(normalized.explanation, /relation defines/i);

  const missingObservation = normalizeAdvancedAnalyticalPlan(plan({
    operation: "distinct_count", source: "people", entity: "people.person_id", metric: "", secondaryMetric: "",
  }), "How many distinct people attended at least once?", [columns[0]]);
  assert.equal(missingObservation.action, "clarify");

  const barePopulation = normalizeAdvancedAnalyticalPlan(plan({
    operation: "distinct_count", source: "people", entity: "people.person_id", metric: "", secondaryMetric: "",
  }), "How many distinct people are there?", [columns[0]]);
  assert.equal(barePopulation.action, "query");
  assert.equal(barePopulation.source, "people");
});

test("conditional-rate compilation applies denominator scope to the numerator", () => {
  const rate = plan({
    operation: "conditional_rate", source: "staff", metric: "", secondaryMetric: "",
    numeratorFilters: [{ column: "staff.team", operator: "eq", value: "North" }],
    denominatorFilters: [{ column: "staff.active", operator: "eq", value: "true" }],
  });
  const query = compileAdvancedAnalyticalPlan(rate, schema).query;
  assert.match(query, /FILTER \(WHERE "staff"\."active" = TRUE AND "staff"\."team" = 'North'\)/);
  assert.match(query, /NULLIF\(COUNT\(\*\) FILTER \(WHERE "staff"\."active" = TRUE\), 0\)/);
});

test("preserves an explicit negated denominator instead of widening the population", () => {
  const normalized = normalizeAdvancedAnalyticalPlan(plan({
    operation: "conditional_rate", source: "staff", metric: "", secondaryMetric: "",
    numeratorFilters: [{ column: "staff.active", operator: "eq", value: "true" }],
    denominatorFilters: [{ column: "staff.team", operator: "neq", value: "North" }],
  }), "Among staff excluding North, what percentage are active?", schema);
  assert.equal(normalized.action, "query");
  assert.deepEqual(normalized.denominatorFilters, [{ column: "staff.team", operator: "neq", value: "North" }]);
  const query = compileAdvancedAnalyticalPlan(normalized, schema).query;
  assert.match(query, /FILTER \(WHERE "staff"\."team" <> 'North' AND "staff"\."active" = TRUE\)/);
  assert.match(query, /NULLIF\(COUNT\(\*\) FILTER \(WHERE "staff"\."team" <> 'North'\), 0\)/);

  const synonymous = normalizeAdvancedAnalyticalPlan(plan({
    operation: "conditional_rate", source: "staff", metric: "", secondaryMetric: "",
    numeratorFilters: [{ column: "staff.active", operator: "eq", value: "true" }],
    denominatorFilters: [{ column: "staff.team", operator: "neq", value: "North" }],
  }), "Among staff other than North, what percentage are active?", schema);
  assert.equal(synonymous.action, "query");
  assert.deepEqual(synonymous.denominatorFilters, [{ column: "staff.team", operator: "neq", value: "North" }]);

  const unverified = normalizeAdvancedAnalyticalPlan(plan({
    operation: "conditional_rate", source: "staff", metric: "", secondaryMetric: "",
    numeratorFilters: [{ column: "staff.active", operator: "eq", value: "true" }],
    denominatorFilters: [{ column: "staff.team", operator: "neq", value: "North" }],
  }), "Leaving out North staff, what percentage are active?", schema);
  assert.equal(unverified.action, "clarify");
  assert.match(unverified.explanation, /denominator scope/i);
});

test("builds its grammar only from the supplied unseen schema", () => {
  const dataset = { id: "h", name: "workforce.duckdb", path: "/private/workforce.duckdb", format: "duckdb" as const, sizeBytes: 1, addedAt: "now" };
  const messages = [{ role: "user" as const, content: "Average hours per staff member" }];
  assert.match(JSON.stringify(buildAdvancedAnalyticalSchema(messages, dataset, schema)), /shifts\.hours/);
  assert.doesNotMatch(buildAdvancedAnalyticalMessages(messages, dataset, schema)[1].content, /private\/workforce/);
});

test("production analytical planners contain no benchmark schema names", () => {
  const source = ["advanced-analytical-plan.ts", "analytical-semantic-roles.ts", "analytical-plan.ts", "sql-proposals.ts"]
    .map((name) => readFileSync(new URL(`../lib/${name}`, import.meta.url), "utf8")).join("\n");
  for (const term of ["campaigns", "payments", "support_tickets", "order_items", "products", "customers", "orders", "staff", "shifts", "incidents", "machines", "runs", "authors", "articles", "members", "loans", "telescopes", "targets", "observations", "calibrations", "observation_runs", "Galaxy", "High", "venues", "productions", "performances", "inspections", "performance_windows", "Musical", "Full"]) {
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
