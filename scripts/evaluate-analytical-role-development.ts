import { runAnalyticalHoldout, type AnalyticalHoldoutDefinition } from "./analytical-holdout-runner.ts";

// This is an explicit development fixture, not transfer evidence. It may be
// rerun while improving the domain-neutral role resolver. Release claims still
// require a newly frozen unseen domain.
const definition: AnalyticalHoldoutDefinition = {
  suite: "analytical-role-development",
  frozenAt: "development",
  evidenceKind: "development",
  databaseName: "analytical-role-development.duckdb",
  setupSql: `
    CREATE TABLE patients AS SELECT i::INTEGER AS patient_id, CASE i % 3 WHEN 0 THEN 'North' WHEN 1 THEN 'South' ELSE 'West' END AS region FROM range(1, 19) t(i);
    CREATE TABLE clinicians AS SELECT i::INTEGER AS clinician_id, CASE i % 2 WHEN 0 THEN 'General' ELSE 'Specialist' END AS practice FROM range(1, 7) t(i);
    CREATE TABLE appointments AS SELECT i::INTEGER AS appointment_id, ((i * 5) % 18 + 1)::INTEGER AS patient_id, ((i * 7) % 6 + 1)::INTEGER AS clinician_id, TIMESTAMP '2026-01-01 08:00:00' + i * INTERVAL '4 hours' AS started_at, TIMESTAMP '2026-01-01 08:00:00' + i * INTERVAL '4 hours' + (15 + i % 50) * INTERVAL '1 minute' AS finished_at, (40 + i % 120)::DOUBLE AS charge_amount, CASE i % 3 WHEN 0 THEN 'Completed' WHEN 1 THEN 'Cancelled' ELSE 'Scheduled' END AS status FROM range(1, 73) t(i);
  `,
  cases: [
    { id: "role-01", question: "What is the average number of appointments per clinician?", goldSql: "SELECT AVG(metric_value) FROM (SELECT clinician_id, COUNT(DISTINCT appointment_id) AS metric_value FROM appointments GROUP BY clinician_id) q", expectedPlan: { operation: "aggregate_over_groups", source: "appointments", metric: "appointments.appointment_id", groupField: "appointments.clinician_id", innerAggregate: "count", outerAggregate: "avg", distinct: true } },
    { id: "role-02", question: "What is the average total charge amount per patient?", goldSql: "SELECT AVG(metric_value) FROM (SELECT patient_id, SUM(charge_amount) AS metric_value FROM appointments GROUP BY patient_id) q", expectedPlan: { operation: "per_entity_average", source: "appointments", metric: "appointments.charge_amount", entity: "appointments.patient_id" } },
    { id: "role-03", question: "How many distinct patients had Completed appointments?", goldSql: "SELECT COUNT(DISTINCT patient_id) FROM appointments WHERE status = 'Completed'", expectedPlan: { operation: "distinct_count", source: "appointments", entity: "appointments.patient_id", filters: [{ column: "appointments.status", operator: "eq", value: "Completed" }] } },
    { id: "role-04", question: "What is the average duration between started at and finished at in hours?", goldSql: "SELECT AVG(DATE_DIFF('minute', started_at, finished_at)) / 60.0 FROM appointments", expectedPlan: { operation: "duration_average", source: "appointments", startField: "appointments.started_at", endField: "appointments.finished_at" } },
    { id: "role-05", question: "Which clinician is best?", boundary: "clarify" },
    { id: "role-06", question: "What is the ratio of total charge amount divided by total appointments?", goldSql: "SELECT SUM(charge_amount) / NULLIF(COUNT(*), 0) FROM appointments", expectedPlan: { operation: "ratio", source: "appointments", metric: "appointments.charge_amount", secondaryMetric: "*" } },
    { id: "role-07", question: "How many patients have at least 4 appointments?", goldSql: "SELECT COUNT(*) FROM (SELECT patient_id FROM appointments GROUP BY patient_id HAVING COUNT(*) >= 4) q", expectedPlan: { operation: "threshold_count", source: "appointments", entity: "appointments.patient_id", threshold: 4 } },
    { id: "role-08", question: "Which patients were never linked to appointments?", goldSql: "SELECT patient_id FROM patients LEFT JOIN appointments USING (patient_id) WHERE appointment_id IS NULL ORDER BY patient_id", expectedPlan: { operation: "anti_join", source: "patients", entity: "patients.patient_id", relatedField: "appointments.appointment_id" } },
    { id: "role-09", question: "What was the growth in total charge amount using started at from January 2026 to February 2026?", goldSql: "WITH p AS (SELECT SUM(charge_amount) FILTER (WHERE started_at >= TIMESTAMP '2026-01-01' AND started_at < TIMESTAMP '2026-02-01') a, SUM(charge_amount) FILTER (WHERE started_at >= TIMESTAMP '2026-02-01' AND started_at < TIMESTAMP '2026-03-01') b FROM appointments) SELECT 100.0 * (b-a) / NULLIF(a,0) FROM p", expectedPlan: { operation: "period_growth", source: "appointments", metric: "appointments.charge_amount", dateField: "appointments.started_at", firstStart: "2026-01-01", firstEnd: "2026-02-01", secondStart: "2026-02-01", secondEnd: "2026-03-01" } },
  ],
};

await runAnalyticalHoldout(definition);
