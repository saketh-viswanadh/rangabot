import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { buildAdvancedAnalyticalMessages, buildAdvancedAnalyticalSchema, shouldUseAdvancedAnalyticalPlan } from "../lib/advanced-analytical-plan.ts";
import { compileGroundedAdvancedAnalyticalPlan, compileResolvedAdvancedAnalyticalPlan } from "../lib/analytical-filter-grounding.ts";
import { buildAnalyticalPlanMessages, buildAnalyticalPlanSchema, compileAnalyticalPlan, normalizeAnalyticalPlan, parseAnalyticalPlan, resolveAnalyticalBoundary } from "../lib/analytical-plan.ts";
import type { ApprovedDataset } from "../lib/datasets.ts";
import { completeJsonWithOllama } from "../lib/providers/ollama.ts";
import type { ChatMessage } from "../lib/providers/types.ts";
import { executeReadOnlySql, inspectDatasetSchema, type SqlExecutionResult } from "../lib/sql-runtime.ts";

type HoldoutCase = { id: string; question: string; goldSql?: string; boundary?: "clarify" | "unavailable" };
const cases: HoldoutCase[] = [
  { id: "lh-01", question: "What is the total distance_km across all trips?", goldSql: "SELECT SUM(distance_km) FROM trips" },
  { id: "lh-02", question: "What is the average fuel_liters per trip?", goldSql: "SELECT AVG(fuel_liters) FROM trips" },
  { id: "lh-03", question: "Show total distance_km by hub.", goldSql: "SELECT hub, SUM(distance_km) FROM trips JOIN drivers USING (driver_id) GROUP BY hub" },
  { id: "lh-04", question: "Show the top 3 corridors by total distance_km.", goldSql: "SELECT corridor, SUM(distance_km) AS value FROM trips JOIN routes USING (route_id) GROUP BY corridor ORDER BY value DESC LIMIT 3" },
  { id: "lh-05", question: "How many active drivers are there?", goldSql: "SELECT COUNT(*) FROM drivers WHERE active = TRUE" },
  { id: "lh-06", question: "What is the average duration between departed_at and arrived_at in hours?", goldSql: "SELECT AVG(DATE_DIFF('minute', departed_at, arrived_at)) / 60.0 FROM trips" },
  { id: "lh-07", question: "What is the ratio of total distance_km divided by total fuel_liters?", goldSql: "SELECT SUM(distance_km) / NULLIF(SUM(fuel_liters), 0) FROM trips" },
  { id: "lh-08", question: "How many drivers completed at least 4 trips?", goldSql: "SELECT COUNT(*) FROM (SELECT driver_id FROM trips GROUP BY driver_id HAVING COUNT(*) >= 4) q" },
  { id: "lh-09", question: "What is the average total distance_km per driver?", goldSql: "SELECT AVG(value) FROM (SELECT driver_id, SUM(distance_km) AS value FROM trips GROUP BY driver_id) q" },
  { id: "lh-10", question: "Which drivers were never inspected?", goldSql: "SELECT driver_id FROM drivers LEFT JOIN inspections USING (driver_id) WHERE inspection_id IS NULL ORDER BY driver_id" },
  { id: "lh-11", question: "What was the percentage growth in total distance_km from January 2025 to February 2025?", goldSql: "WITH p AS (SELECT SUM(distance_km) FILTER (WHERE trip_date >= DATE '2025-01-01' AND trip_date < DATE '2025-02-01') a, SUM(distance_km) FILTER (WHERE trip_date >= DATE '2025-02-01' AND trip_date < DATE '2025-03-01') b FROM trips) SELECT 100.0 * (b-a) / NULLIF(a,0) FROM p" },
  { id: "lh-12", question: "Which hub is best?", boundary: "clarify" },
];

const outputDirectory = resolve("data/evaluations/results");
const databasePath = resolve(outputDirectory, "analytical-holdout-v1.duckdb");
mkdirSync(outputDirectory, { recursive: true });

async function createDatabase() {
  if (existsSync(databasePath)) unlinkSync(databasePath);
  const instance = await DuckDBInstance.create(databasePath); const connection = await instance.connect();
  try {
    await connection.run(`
      CREATE TABLE drivers AS SELECT i::INTEGER driver_id, CASE i % 3 WHEN 0 THEN 'Harbor' WHEN 1 THEN 'Hill' ELSE 'Central' END hub, (i % 5 <> 0) active FROM range(1, 19) t(i);
      CREATE TABLE routes AS SELECT i::INTEGER route_id, CASE i % 4 WHEN 0 THEN 'North Loop' WHEN 1 THEN 'Coastal' WHEN 2 THEN 'Valley' ELSE 'Metro' END corridor FROM range(1, 9) t(i);
      CREATE TABLE trips AS SELECT i::INTEGER trip_id, ((i * 7) % 18 + 1)::INTEGER driver_id, ((i * 3) % 8 + 1)::INTEGER route_id, TIMESTAMP '2025-01-01 06:00:00' + i * INTERVAL '11 hours' departed_at, TIMESTAMP '2025-01-01 06:00:00' + i * INTERVAL '11 hours' + (2 + i % 7) * INTERVAL '1 hour' arrived_at, (45 + (i * 17) % 260)::DOUBLE distance_km, (8 + (i * 5) % 31)::DOUBLE fuel_liters, DATE '2025-01-01' + ((i * 3) % 75)::INTEGER trip_date, CASE WHEN i % 11 = 0 THEN 'cancelled' ELSE 'completed' END status FROM range(1, 121) t(i);
      CREATE TABLE inspections AS SELECT i::INTEGER inspection_id, ((i * 4) % 18 + 1)::INTEGER driver_id, DATE '2025-01-01' + (i * 5)::INTEGER inspection_date, (i % 4 <> 0) passed FROM range(1, 25) t(i);
    `);
  } finally { connection.closeSync(); instance.closeSync(); }
}

function cell(value: unknown) { return value === null ? "null" : typeof value === "object" ? JSON.stringify(value) : String(value); }
function equivalent(left: unknown, right: unknown) {
  const a = Number(cell(left)); const b = Number(cell(right));
  if (Number.isFinite(a) && Number.isFinite(b)) return Math.abs(a - b) <= Math.max(0.02, Math.abs(b) * 0.0001);
  return cell(left).toLowerCase() === cell(right).toLowerCase();
}
function resultsMatch(candidate: SqlExecutionResult, gold: SqlExecutionResult) {
  return candidate.rows.length === gold.rows.length && gold.rows.every((row) => candidate.rows.some((other) => row.every((value) => other.some((item) => equivalent(item, value)))));
}

await createDatabase();
const dataset: ApprovedDataset = { id: "holdout-v1", name: "logistics-holdout.duckdb", path: databasePath, format: "duckdb", sizeBytes: 0, addedAt: new Date().toISOString() };
const schema = await inspectDatasetSchema(databasePath);
const results = [];
for (const item of cases) {
  const started = Date.now(); const messages: ChatMessage[] = [{ role: "user", content: item.question }];
  try {
    const resolved = shouldUseAdvancedAnalyticalPlan(item.question) ? await compileResolvedAdvancedAnalyticalPlan(item.question, schema, databasePath) : null;
    const proposal = shouldUseAdvancedAnalyticalPlan(item.question)
      ? resolved?.proposal ?? (await compileGroundedAdvancedAnalyticalPlan(await completeJsonWithOllama(buildAdvancedAnalyticalMessages(messages, dataset, schema), { jsonSchema: buildAdvancedAnalyticalSchema(messages, dataset, schema), numPredict: 900, timeoutMs: 180_000 }), item.question, schema, databasePath)).proposal
      : compileAnalyticalPlan(resolveAnalyticalBoundary(item.question) ?? normalizeAnalyticalPlan(parseAnalyticalPlan(await completeJsonWithOllama(buildAnalyticalPlanMessages(messages, dataset, schema), { jsonSchema: buildAnalyticalPlanSchema(messages, dataset, schema), numPredict: 700, timeoutMs: 180_000 })), item.question, schema), schema);
    if (item.boundary) results.push({ ...item, action: proposal.action, sql: proposal.query, passed: proposal.action === item.boundary, latencyMs: Date.now() - started });
    else {
      const candidate = await executeReadOnlySql({ approvedDatasetPath: databasePath, query: proposal.query });
      const gold = await executeReadOnlySql({ approvedDatasetPath: databasePath, query: item.goldSql! });
      results.push({ ...item, action: proposal.action, sql: proposal.query, passed: resultsMatch(candidate, gold), latencyMs: Date.now() - started });
    }
  } catch (error) { results.push({ ...item, action: "error", sql: null, passed: false, error: error instanceof Error ? error.message : String(error), latencyMs: Date.now() - started }); }
  console.log(`${results.at(-1)?.passed ? "PASS" : "FAIL"} ${item.id}`);
}
const timestamp = new Date().toISOString().replaceAll(":", "-");
const outputPath = resolve(outputDirectory, `analytical-holdout-v1-${timestamp}.json`);
writeFileSync(outputPath, JSON.stringify({ suite: "analytical-holdout-v1", frozenAt: "2026-08-03", cases: results }, null, 2));
const passed = results.filter((item) => item.passed).length;
console.log(`\nFrozen holdout: ${passed}/${results.length} passed.`);
console.log(`Private result: ${outputPath}`);
