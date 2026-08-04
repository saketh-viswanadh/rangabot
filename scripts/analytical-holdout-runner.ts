import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { buildAdvancedAnalyticalMessages, buildAdvancedAnalyticalSchema, compileAdvancedAnalyticalPlan, normalizeAdvancedAnalyticalPlan, parseAdvancedAnalyticalPlan, shouldUseAdvancedAnalyticalPlan } from "../lib/advanced-analytical-plan.ts";
import { buildAnalyticalPlanMessages, buildAnalyticalPlanSchema, compileAnalyticalPlan, normalizeAnalyticalPlan, parseAnalyticalPlan } from "../lib/analytical-plan.ts";
import type { ApprovedDataset } from "../lib/datasets.ts";
import { completeJsonWithOllama } from "../lib/providers/ollama.ts";
import type { ChatMessage } from "../lib/providers/types.ts";
import { executeReadOnlySql, inspectDatasetSchema, type SqlExecutionResult } from "../lib/sql-runtime.ts";

export type AnalyticalHoldoutCase = { id: string; question: string; goldSql?: string; boundary?: "clarify" | "unavailable" };
export type AnalyticalHoldoutDefinition = { suite: string; frozenAt: string; databaseName: string; setupSql: string; cases: AnalyticalHoldoutCase[]; outputDirectory?: string };

function cell(value: unknown) { return value === null ? "null" : typeof value === "object" ? JSON.stringify(value) : String(value); }
function equivalent(left: unknown, right: unknown) {
  const a = Number(cell(left)); const b = Number(cell(right));
  if (Number.isFinite(a) && Number.isFinite(b)) return Math.abs(a - b) <= Math.max(0.02, Math.abs(b) * 0.0001);
  return cell(left).toLowerCase() === cell(right).toLowerCase();
}
function resultsMatch(candidate: SqlExecutionResult, gold: SqlExecutionResult) {
  return candidate.rows.length === gold.rows.length && gold.rows.every((row) => candidate.rows.some((other) => row.every((value) => other.some((item) => equivalent(item, value)))));
}

export async function runAnalyticalHoldout(definition: AnalyticalHoldoutDefinition) {
  const outputDirectory = resolve(definition.outputDirectory ?? "data/evaluations/results"); const databasePath = resolve(outputDirectory, definition.databaseName);
  mkdirSync(dirname(databasePath), { recursive: true }); if (existsSync(databasePath)) unlinkSync(databasePath);
  const instance = await DuckDBInstance.create(databasePath); const connection = await instance.connect();
  try { await connection.run(definition.setupSql); } finally { connection.closeSync(); instance.closeSync(); }
  const dataset: ApprovedDataset = { id: definition.suite, name: definition.databaseName, path: databasePath, format: "duckdb", sizeBytes: 0, addedAt: new Date().toISOString() };
  const schema = await inspectDatasetSchema(databasePath); const results = [];
  // Validate every reference calculation before invoking the model. A broken
  // evaluator must fail the suite, never count as a Rangabot failure.
  const goldResults = new Map<string, SqlExecutionResult>();
  for (const item of definition.cases) {
    if (item.boundary) {
      if (item.goldSql) throw new Error(`Boundary case ${item.id} must not include gold SQL.`);
      continue;
    }
    if (!item.goldSql) throw new Error(`Executable case ${item.id} is missing gold SQL.`);
    try { goldResults.set(item.id, await executeReadOnlySql({ approvedDatasetPath: databasePath, query: item.goldSql })); }
    catch (error) { throw new Error(`Holdout preflight failed for ${item.id}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  for (const item of definition.cases) {
    const started = Date.now(); const messages: ChatMessage[] = [{ role: "user", content: item.question }];
    try {
      const proposal = shouldUseAdvancedAnalyticalPlan(item.question)
        ? compileAdvancedAnalyticalPlan(normalizeAdvancedAnalyticalPlan(parseAdvancedAnalyticalPlan(await completeJsonWithOllama(buildAdvancedAnalyticalMessages(messages, dataset, schema), { jsonSchema: buildAdvancedAnalyticalSchema(messages, dataset, schema), numPredict: 900, timeoutMs: 180_000 })), item.question, schema), schema)
        : compileAnalyticalPlan(normalizeAnalyticalPlan(parseAnalyticalPlan(await completeJsonWithOllama(buildAnalyticalPlanMessages(messages, dataset, schema), { jsonSchema: buildAnalyticalPlanSchema(messages, dataset, schema), numPredict: 700, timeoutMs: 180_000 })), item.question, schema), schema);
      if (item.boundary) results.push({ ...item, action: proposal.action, sql: proposal.query, passed: proposal.action === item.boundary, latencyMs: Date.now() - started });
      else {
        const candidate = await executeReadOnlySql({ approvedDatasetPath: databasePath, query: proposal.query });
        const gold = goldResults.get(item.id)!;
        results.push({ ...item, action: proposal.action, sql: proposal.query, passed: resultsMatch(candidate, gold), latencyMs: Date.now() - started });
      }
    } catch (error) { results.push({ ...item, action: "error", sql: null, passed: false, error: error instanceof Error ? error.message : String(error), latencyMs: Date.now() - started }); }
    console.log(`${results.at(-1)?.passed ? "PASS" : "FAIL"} ${item.id}`);
  }
  const timestamp = new Date().toISOString().replaceAll(":", "-"); const outputPath = resolve(outputDirectory, `${definition.suite}-${timestamp}.json`);
  writeFileSync(outputPath, JSON.stringify({ suite: definition.suite, frozenAt: definition.frozenAt, cases: results }, null, 2));
  const passed = results.filter((item) => item.passed).length;
  console.log(`\nFrozen holdout: ${passed}/${results.length} passed.`); console.log(`Private result: ${outputPath}`);
  return { passed, total: results.length, outputPath };
}
