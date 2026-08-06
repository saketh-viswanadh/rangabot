import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { arch, cpus, platform, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { issueAuthorizedAnalyticsRequest } from "../lib/analytics-pack-control.ts";
import { runAnalyticsExpertPack } from "../lib/analytics-expert-pack.ts";
import { buildAdvancedAnalyticalMessages, buildAdvancedAnalyticalSchema, shouldUseAdvancedAnalyticalPlan } from "../lib/advanced-analytical-plan.ts";
import { compileGroundedAdvancedAnalyticalPlan, compileResolvedAdvancedAnalyticalPlan } from "../lib/analytical-filter-grounding.ts";
import { buildAnalyticalPlanMessages, buildAnalyticalPlanSchema, compileAnalyticalPlan, normalizeAnalyticalPlan, parseAnalyticalPlan, resolveAnalyticalBoundary } from "../lib/analytical-plan.ts";
import type { ApprovedDataset } from "../lib/datasets.ts";
import { getExpertPackManifest } from "../lib/expert-pack-registry.ts";
import { validateExpertPackResult } from "../lib/expert-packs.ts";
import { getConfiguredChatModel, getConfiguredContextTokens, getLocalOllamaBaseUrl } from "../lib/local-runtime-config.ts";
import { completeJsonWithOllama, completeTextWithOllama } from "../lib/providers/ollama.ts";
import type { ChatMessage } from "../lib/providers/types.ts";
import { analysisNarrationIsGrounded, formatVerifiedAnalysisFallback } from "../lib/conversational-analysis.ts";
import type { SqlProposal } from "../lib/sql-proposals.ts";
import { executeReadOnlySql, inspectDatasetIdentity, inspectDatasetSchema, type SqlExecutionResult } from "../lib/sql-runtime.ts";

export type ExpectedAnalyticalPlan = {
  operation?: string;
  aggregate?: string;
  source?: string;
  metric?: string;
  secondaryMetric?: string;
  entity?: string;
  groupField?: string;
  innerAggregate?: string;
  outerAggregate?: string;
  distinct?: boolean;
  startField?: string;
  endField?: string;
  dateField?: string;
  relatedField?: string;
  dimensions?: string[];
  filters?: Array<{ column: string; operator: string; value: string }>;
  numeratorFilters?: Array<{ column: string; operator: string; value: string }>;
  denominatorFilters?: Array<{ column: string; operator: string; value: string }>;
  threshold?: number;
  firstStart?: string;
  firstEnd?: string;
  secondStart?: string;
  secondEnd?: string;
};
export type AnalyticalHoldoutCase = { id: string; question: string; goldSql?: string; boundary?: "clarify" | "unavailable"; expectedPlan?: ExpectedAnalyticalPlan };
export type AnalyticalHoldoutDefinition = { suite: string; frozenAt: string; databaseName: string; setupSql: string; cases: AnalyticalHoldoutCase[]; outputDirectory?: string; evidenceKind?: "sealed" | "development" };
export type AnalyticalHoldoutRunOptions = { mode?: "legacy" | "expert-pack" };

const runnerVersion = "2.0.0";

function cell(value: unknown) { return value === null ? "null" : typeof value === "object" ? JSON.stringify(value) : String(value); }
function equivalent(left: unknown, right: unknown) {
  const a = Number(cell(left)); const b = Number(cell(right));
  if (Number.isFinite(a) && Number.isFinite(b)) return Math.abs(a - b) <= Math.max(0.02, Math.abs(b) * 0.0001);
  return cell(left).toLowerCase() === cell(right).toLowerCase();
}
function resultsMatch(candidate: SqlExecutionResult, gold: SqlExecutionResult) {
  return candidate.rows.length === gold.rows.length && gold.rows.every((row) => candidate.rows.some((other) => row.every((value) => other.some((item) => equivalent(item, value)))));
}
export function analyticalPlanMatchesExpected(plan: Record<string, unknown>, expected?: ExpectedAnalyticalPlan) {
  if (!expected) return true;
  return Object.entries(expected).every(([field, value]) => Array.isArray(value)
    ? JSON.stringify(plan[field]) === JSON.stringify(value)
    : plan[field] === value);
}

function commandOutput(command: string, args: string[]) {
  try {
    return execFileSync(command, args, { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

async function localModelProfile(modelId: string) {
  try {
    const baseUrl = getLocalOllamaBaseUrl();
    const signal = AbortSignal.timeout(3_000);
    const [showResponse, runningResponse] = await Promise.all([
      fetch(`${baseUrl}/api/show`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: modelId }), signal }),
      fetch(`${baseUrl}/api/ps`, { cache: "no-store", signal }),
    ]);
    const show = showResponse.ok ? await showResponse.json() as { details?: { family?: unknown; parameter_size?: unknown; quantization_level?: unknown } } : {};
    const running = runningResponse.ok ? await runningResponse.json() as { models?: Array<{ name?: unknown; model?: unknown }> } : {};
    const loaded = running.models?.some((model) => model.name === modelId || model.model === modelId) ?? false;
    return {
      family: typeof show.details?.family === "string" ? show.details.family : "unknown",
      parameterSize: typeof show.details?.parameter_size === "string" ? show.details.parameter_size : "unknown",
      quantization: typeof show.details?.quantization_level === "string" ? show.details.quantization_level : "unknown",
      coldWarmState: loaded ? "warm" : "cold",
    };
  } catch {
    return { family: "unknown", parameterSize: "unknown", quantization: "unknown", coldWarmState: "unknown" };
  }
}

function latencySummary(values: number[]) {
  if (!values.length) return { meanMs: 0, medianMs: 0, p95Ms: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return {
    meanMs: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 10) / 10,
    medianMs: Math.round(median * 10) / 10,
    p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)],
  };
}

function exactStringSet(actual: string[], expected: string[]) {
  return actual.length === expected.length && expected.every((item) => actual.includes(item));
}

function packExecutionAudit(input: {
  request: NonNullable<ReturnType<typeof issueAuthorizedAnalyticsRequest>>;
  outcome: Awaited<ReturnType<typeof runAnalyticsExpertPack>>;
  dataset: ApprovedDataset;
  candidate?: SqlExecutionResult;
}) {
  const manifest = getExpertPackManifest("analytics");
  if (!manifest) throw new Error("The Analytics Pack manifest is missing during evaluation.");
  const envelope = validateExpertPackResult(input.outcome.result, manifest, input.request);
  const expectedGrants = [`${input.request.requestId}:dataset`, `${input.request.requestId}:runtime`];
  const expectedPermissions = ["approved-dataset:read", "local-runtime:execute"];
  const response = input.outcome.result.responseProposal ?? "";
  const warnings = input.outcome.result.warnings;
  const fallbackWarning = warnings.length === 1 && ["model-narration-unavailable", "narration-grounding-rejected"].includes(warnings[0].code);
  const answerPass = input.candidate
    ? analysisNarrationIsGrounded(response, input.candidate)
      && (warnings.length === 0 || fallbackWarning && response === formatVerifiedAnalysisFallback(input.candidate))
    : input.outcome.result.status === "clarification"
      && response === input.outcome.result.clarification;
  const evidence = input.outcome.result.evidence[0]?.localExecution;
  const evidencePass = input.candidate
    ? input.outcome.result.evidence.length === 1
      && input.outcome.result.evidence[0].source === "local-execution"
      && evidence?.resourceId === input.dataset.id
      && evidence.inputSha256 === input.candidate.receipt.input.sha256
      && evidence.querySha256 === input.candidate.receipt.querySha256
      && evidence.returnedRows === input.candidate.receipt.returnedRows
      && evidence.truncated === input.candidate.receipt.truncated
      && evidence.rowLimit === input.candidate.receipt.rowLimit
    : input.outcome.result.evidence.length === 0;
  const receiptPass = exactStringSet(input.outcome.result.receipt.permissionsUsed, expectedPermissions)
    && exactStringSet(input.outcome.result.receipt.grantIdsUsed, expectedGrants)
    && exactStringSet(input.outcome.result.receipt.toolsUsed, ["duckdb-readonly"])
    && input.outcome.result.receipt.modelSwitches === 0
    && (!input.candidate || input.outcome.result.receipt.model?.resolvedModelId === getConfiguredChatModel());
  return {
    envelopePass: envelope.valid,
    envelopeErrors: envelope.errors,
    evidencePass,
    receiptPass,
    answerPass,
    responseMode: warnings.length === 0 ? "model-grounded" : warnings[0].code,
    warnings,
    resultStatus: input.outcome.result.status,
    resolvedModelId: input.outcome.result.receipt.model?.resolvedModelId ?? null,
  };
}

export async function runAnalyticalHoldout(definition: AnalyticalHoldoutDefinition, options: AnalyticalHoldoutRunOptions = {}) {
  const mode = options.mode ?? "legacy";
  const startedAt = new Date().toISOString();
  const modelId = getConfiguredChatModel();
  const modelProfile = await localModelProfile(modelId);
  const sourceCommit = commandOutput("git", ["rev-parse", "HEAD"]) ?? "unknown";
  const gitStatus = commandOutput("git", ["status", "--porcelain"]);
  const sourceDirty = gitStatus === null ? "unknown" : gitStatus.length > 0;
  const packManifest = mode === "expert-pack" ? getExpertPackManifest("analytics") : null;
  const provenance = {
    runnerVersion,
    source: { commit: sourceCommit, dirty: sourceDirty },
    pack: packManifest ? { id: packManifest.id, version: packManifest.version, maturity: packManifest.maturity } : null,
    model: { id: modelId, contextTokens: getConfiguredContextTokens(), ...modelProfile },
    ollamaVersion: commandOutput("ollama", ["--version"]) ?? "unknown",
    hardware: {
      platform: platform(),
      architecture: arch(),
      memoryMb: Math.round(totalmem() / 1024 / 1024),
      cpuModel: cpus()[0]?.model ?? "unknown",
      logicalCpuCount: cpus().length,
    },
  };
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
  if (process.env.RANGABOT_HOLDOUT_PREFLIGHT_ONLY === "1") {
    console.log(`PASS: ${definition.suite} setup and ${goldResults.size} reference queries are valid; no model cases ran.`);
    return { passed: 0, total: definition.cases.length, outputPath: "" };
  }
  for (const item of definition.cases) {
    const started = Date.now(); const messages: ChatMessage[] = [{ role: "user", content: item.question }];
    try {
      let plan: unknown;
      let proposal: SqlProposal;
      let packAudit: ReturnType<typeof packExecutionAudit> | undefined;
      let packOutcome: Awaited<ReturnType<typeof runAnalyticsExpertPack>> | undefined;
      let packRequest: NonNullable<ReturnType<typeof issueAuthorizedAnalyticsRequest>> | undefined;
      if (mode === "expert-pack") {
        const conversationId = `${definition.suite}-${item.id}`;
        const request = issueAuthorizedAnalyticsRequest({
          conversation: { id: conversationId, title: item.id, messages, projectId: null, datasetId: dataset.id, pinned: false, createdAt: definition.frozenAt, updatedAt: definition.frozenAt },
          conversationId, datasetId: dataset.id, submittedMessages: messages, requestId: `${conversationId}-request`,
        });
        if (!request) throw new Error("The evaluator could not issue a scoped Analytics Pack request.");
        packRequest = request;
        const outcome = await runAnalyticsExpertPack(request, {
          getDataset: (id) => id === dataset.id ? dataset : null,
          inspectIdentity: (path, inspectionOptions) => inspectDatasetIdentity(path, inspectionOptions),
          inspectSchema: (path, inspectionOptions) => inspectDatasetSchema(path, inspectionOptions),
          completeJson: (input, generationOptions) => completeJsonWithOllama(input, { ...generationOptions, timeoutMs: 180_000 }),
          completeText: (input, generationOptions) => completeTextWithOllama(input, { ...generationOptions, timeoutMs: 180_000 }),
          executeSql: executeReadOnlySql,
          configuredModel: getConfiguredChatModel,
        });
        packOutcome = outcome;
        if (!outcome.diagnostics) throw new Error(outcome.result.error?.message ?? "The Analytics Pack returned no diagnostic plan.");
        plan = outcome.diagnostics.plan;
        proposal = outcome.diagnostics.proposal;
      } else {
        const advanced = shouldUseAdvancedAnalyticalPlan(item.question);
        if (advanced) {
          const compiled = await compileResolvedAdvancedAnalyticalPlan(item.question, schema, databasePath)
            ?? await compileGroundedAdvancedAnalyticalPlan(await completeJsonWithOllama(buildAdvancedAnalyticalMessages(messages, dataset, schema), { jsonSchema: buildAdvancedAnalyticalSchema(messages, dataset, schema), numPredict: 900, timeoutMs: 180_000 }), item.question, schema, databasePath);
          plan = compiled.plan;
          proposal = compiled.proposal;
        } else {
          const boundary = resolveAnalyticalBoundary(item.question);
          const raw = boundary ? null : await completeJsonWithOllama(buildAnalyticalPlanMessages(messages, dataset, schema), { jsonSchema: buildAnalyticalPlanSchema(messages, dataset, schema), numPredict: 700, timeoutMs: 180_000 });
          const basicPlan = boundary ?? normalizeAnalyticalPlan(parseAnalyticalPlan(raw!), item.question, schema);
          plan = basicPlan;
          proposal = compileAnalyticalPlan(basicPlan, schema);
        }
      }
      const semanticPass = analyticalPlanMatchesExpected(plan as unknown as Record<string, unknown>, item.expectedPlan);
      if (item.boundary) {
        if (packOutcome && packRequest) packAudit = packExecutionAudit({ request: packRequest, outcome: packOutcome, dataset });
        const packPass = !packAudit || packAudit.envelopePass && packAudit.evidencePass && packAudit.receiptPass && packAudit.answerPass;
        results.push({ ...item, action: proposal.action, plan, sql: proposal.query, packAudit, passed: proposal.action === item.boundary && semanticPass && packPass, latencyMs: Date.now() - started });
      }
      else {
        const candidate = await executeReadOnlySql({ approvedDatasetPath: databasePath, query: proposal.query });
        const gold = goldResults.get(item.id)!;
        if (packOutcome && packRequest) packAudit = packExecutionAudit({ request: packRequest, outcome: packOutcome, dataset, candidate });
        const packPass = !packAudit || packAudit.envelopePass && packAudit.evidencePass && packAudit.receiptPass && packAudit.answerPass;
        results.push({ ...item, action: proposal.action, plan, sql: proposal.query, packAudit, passed: semanticPass && resultsMatch(candidate, gold) && packPass, latencyMs: Date.now() - started });
      }
    } catch (error) { results.push({ ...item, action: "error", sql: null, passed: false, error: error instanceof Error ? error.message : String(error), latencyMs: Date.now() - started }); }
    console.log(`${results.at(-1)?.passed ? "PASS" : "FAIL"} ${item.id}`);
  }
  const timestamp = new Date().toISOString().replaceAll(":", "-"); const outputPath = resolve(outputDirectory, `${definition.suite}-${timestamp}.json`);
  const latencies = results.map((item) => item.latencyMs);
  const completedAt = new Date().toISOString();
  const summary = {
    passed: results.filter((item) => item.passed).length,
    total: results.length,
    failed: results.filter((item) => !item.passed).length,
    executionErrors: results.filter((item) => item.action === "error").length,
    latency: latencySummary(latencies),
  };
  writeFileSync(outputPath, JSON.stringify({ schemaVersion: 2, suite: definition.suite, frozenAt: definition.frozenAt, mode, startedAt, completedAt, provenance, summary, cases: results }, null, 2));
  const passed = summary.passed;
  const label = definition.evidenceKind === "development" ? "Development suite" : "Frozen holdout";
  console.log(`\n${label} (${mode}): ${passed}/${results.length} passed.`); console.log(`Private result: ${outputPath}`);
  return { passed, total: results.length, outputPath };
}
