import assert from "node:assert/strict";
import test from "node:test";
import { resolveAnalyticalSemanticRoles } from "../lib/analytical-semantic-roles.ts";

const clinic = [
  { table: "patients", name: "patient_id", type: "INTEGER" },
  { table: "patients", name: "region", type: "VARCHAR" },
  { table: "clinicians", name: "clinician_id", type: "INTEGER" },
  { table: "appointments", name: "appointment_id", type: "INTEGER" },
  { table: "appointments", name: "patient_id", type: "INTEGER" },
  { table: "appointments", name: "clinician_id", type: "INTEGER" },
  { table: "appointments", name: "started_at", type: "TIMESTAMP" },
  { table: "appointments", name: "finished_at", type: "TIMESTAMP" },
  { table: "appointments", name: "charge_amount", type: "DOUBLE" },
];

const listening = [
  { table: "listeners", name: "listener_id", type: "INTEGER" },
  { table: "artists", name: "artist_id", type: "INTEGER" },
  { table: "tracks", name: "track_id", type: "INTEGER" },
  { table: "tracks", name: "artist_id", type: "INTEGER" },
  { table: "plays", name: "play_id", type: "INTEGER" },
  { table: "plays", name: "listener_id", type: "INTEGER" },
  { table: "plays", name: "track_id", type: "INTEGER" },
  { table: "plays", name: "seconds_played", type: "DOUBLE" },
];

test("resolves count target, group and measure on an unseen clinical schema", () => {
  const count = resolveAnalyticalSemanticRoles("What is the average number of appointments per clinician?", clinic);
  assert.equal(count.countTarget.value, "appointments.appointment_id");
  assert.equal(count.group.value, "clinicians.clinician_id");

  const total = resolveAnalyticalSemanticRoles("What is the average total charge amount per patient?", clinic);
  assert.equal(total.measure.value, "appointments.charge_amount");
  assert.equal(total.group.value, "patients.patient_id");
});

test("resolves ratio measures without model or domain rules", () => {
  const roles = resolveAnalyticalSemanticRoles("What is the ratio of total seconds played divided by total plays?", listening);
  assert.equal(roles.measure.value, "plays.seconds_played");
  assert.equal(roles.secondaryMeasure.confidence, "none");
  assert.equal(roles.denominatorRelation.value, "plays");
});

test("prefers the first explicitly named distinct population", () => {
  const roles = resolveAnalyticalSemanticRoles("How many distinct listeners played tracks at least once?", listening);
  assert.equal(roles.countTarget.value, "listeners.listener_id");
});

test("resolves same-relation duration endpoints", () => {
  const roles = resolveAnalyticalSemanticRoles("What is the average duration between started at and finished at in hours?", clinic);
  assert.equal(roles.startTime.value, "appointments.started_at");
  assert.equal(roles.endTime.value, "appointments.finished_at");
});

test("fails closed when a requested role is absent or ambiguous", () => {
  const absent = resolveAnalyticalSemanticRoles("What is the average rainfall per patient?", clinic);
  assert.equal(absent.measure.value, null);
  assert.equal(absent.measure.confidence, "none");

  const ambiguous = resolveAnalyticalSemanticRoles("What is the average number per person?", clinic);
  assert.equal(ambiguous.countTarget.value, null);
  assert.notEqual(ambiguous.countTarget.confidence, "high");
});

test("resolves threshold, unmatched-relation and period roles", () => {
  const deviceSchema = [
    { table: "devices", name: "device_id", type: "INTEGER" },
    { table: "readings", name: "reading_id", type: "INTEGER" },
    { table: "readings", name: "device_id", type: "INTEGER" },
    { table: "readings", name: "recorded_on", type: "DATE" },
    { table: "readings", name: "energy_kwh", type: "DOUBLE" },
    { table: "maintenance", name: "maintenance_id", type: "INTEGER" },
    { table: "maintenance", name: "device_id", type: "INTEGER" },
  ];
  const threshold = resolveAnalyticalSemanticRoles("How many devices have at least 3 readings?", deviceSchema);
  assert.equal(threshold.thresholdEntity.value, "devices.device_id");
  assert.equal(threshold.thresholdRelation.value, "readings");

  const unmatched = resolveAnalyticalSemanticRoles("Which devices were never linked to maintenance?", deviceSchema);
  assert.equal(unmatched.unmatchedEntity.value, "devices.device_id");
  assert.equal(unmatched.relatedRelation.value, "maintenance");

  const period = resolveAnalyticalSemanticRoles("Show growth in energy kwh using recorded on from January 2026 to February 2026.", deviceSchema);
  assert.equal(period.measure.value, "readings.energy_kwh");
  assert.equal(period.dateField.value, "readings.recorded_on");
});
