import { buildAdvancedAnalyticalMessages, buildAdvancedAnalyticalSchema, shouldUseAdvancedAnalyticalPlan } from "./advanced-analytical-plan.ts";
import { buildAnalyticalPlanMessages, buildAnalyticalPlanSchema, compileAnalyticalPlan, normalizeAnalyticalPlan, parseAnalyticalPlan, resolveAnalyticalBoundary } from "./analytical-plan.ts";
import { compileGroundedAdvancedAnalyticalPlan, compileResolvedAdvancedAnalyticalPlan } from "./analytical-filter-grounding.ts";
import { analysisNarrationIsGrounded, buildAnalysisNarrationMessages, formatVerifiedAnalysisFallback } from "./conversational-analysis.ts";
import { getApprovedDataset, type ApprovedDataset } from "./datasets.ts";
import { getExpertPackManifest } from "./expert-pack-registry.ts";
import { type ExpertPackFailureCode, type ExpertPackManifest, type ExpertPackModelResolution, type ExpertPackPermission, type ExpertPackRequest, type ExpertPackResult, type ExpertPackWarningCode, validateExpertPackRequest, validateExpertPackResult } from "./expert-packs.ts";
import { getConfiguredChatModel } from "./local-runtime-config.ts";
import { completeJsonWithOllama, completeTextWithOllama } from "./providers/ollama.ts";
import { ProviderError, type ChatMessage, type GenerationOptions } from "./providers/types.ts";
import type { SqlProposal } from "./sql-proposals.ts";
import { executeReadOnlySql, inspectDatasetIdentity, inspectDatasetSchema, SqlRuntimeError, type DatasetColumn, type SqlExecutionResult } from "./sql-runtime.ts";

function requireManifest(): ExpertPackManifest {
  const installed = getExpertPackManifest("analytics");
  if (!installed) throw new Error("The bundled Analytics Expert Pack manifest is missing.");
  return installed;
}

const manifest = requireManifest();

export type AnalyticsPackDependencies = {
  getDataset(id: string): ApprovedDataset | null;
  inspectIdentity(path: string, options?: { signal?: AbortSignal }): ReturnType<typeof inspectDatasetIdentity>;
  inspectSchema(path: string, options?: { signal?: AbortSignal }): Promise<DatasetColumn[]>;
  completeJson(messages: ChatMessage[], options?: GenerationOptions): Promise<string>;
  completeText(messages: ChatMessage[], options?: GenerationOptions): Promise<string>;
  executeSql(input: { approvedDatasetPath: string; query: string; expectedInputSha256?: string; signal?: AbortSignal }): Promise<SqlExecutionResult>;
  configuredModel(): string;
};

const defaultDependencies: AnalyticsPackDependencies = {
  getDataset: getApprovedDataset,
  inspectIdentity: inspectDatasetIdentity,
  inspectSchema: inspectDatasetSchema,
  completeJson: completeJsonWithOllama,
  completeText: completeTextWithOllama,
  executeSql: executeReadOnlySql,
  configuredModel: getConfiguredChatModel,
};

export type AnalyticsPackOutcome = {
  result: ExpertPackResult;
  trace?: NonNullable<ChatMessage["analysisTrace"]>;
  /** Private evaluator seam; never serialized by the chat route. */
  diagnostics?: { plan: Record<string, unknown>; proposal: SqlProposal };
};

type Usage = {
  permissions: Set<ExpertPackPermission>;
  grantIds: Set<string>;
  tools: Set<string>;
  model?: ExpertPackModelResolution;
};

type PackPhase = "preflight" | "identity" | "schema" | "planning" | "execution" | "narration";

function emptyUsage(): Usage {
  return { permissions: new Set(), grantIds: new Set(), tools: new Set() };
}

function receipt(usage: Usage) {
  return {
    permissionsUsed: [...usage.permissions],
    grantIdsUsed: [...usage.grantIds],
    toolsUsed: [...usage.tools],
    ...(usage.model ? { model: usage.model } : {}),
    modelSwitches: 0,
  };
}

function checkedOutcome(request: ExpertPackRequest, result: ExpertPackResult, trace?: NonNullable<ChatMessage["analysisTrace"]>, diagnostics?: AnalyticsPackOutcome["diagnostics"]): AnalyticsPackOutcome {
  const validation = validateExpertPackResult(result, manifest, request);
  if (!validation.valid) throw new Error(`The Analytics Pack returned an invalid result: ${validation.errors.join("; ")}`);
  return { result, ...(trace ? { trace } : {}), ...(diagnostics ? { diagnostics } : {}) };
}

function invalidRequestOutcome(value: unknown, errors: string[]): AnalyticsPackOutcome {
  const candidate = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const requestId = typeof candidate.requestId === "string" && candidate.requestId.length > 0 && candidate.requestId.length <= 120
    ? candidate.requestId
    : "invalid-request";
  return {
    result: {
      requestId,
      packId: manifest.id,
      packVersion: manifest.version,
      status: "failure",
      evidence: [],
      modelBackgroundClaims: [],
      warnings: [],
      error: { code: "invalid-output", message: errors.join("; ").slice(0, 1_000) || "The Analytics Pack request is invalid.", retryable: false },
      receipt: { permissionsUsed: [], grantIdsUsed: [], toolsUsed: [], modelSwitches: 0 },
    },
  };
}

function failure(request: ExpertPackRequest, code: ExpertPackFailureCode, message: string, retryable = false, usage = emptyUsage()): AnalyticsPackOutcome {
  return checkedOutcome(request, {
    requestId: request.requestId,
    packId: manifest.id,
    packVersion: manifest.version,
    status: code === "cancelled" ? "cancelled" : "failure",
    evidence: [],
    modelBackgroundClaims: [],
    warnings: [],
    error: { code, message, retryable },
    receipt: receipt(usage),
  });
}

function modelReceipt(request: ExpertPackRequest, modelId: string, reason: string): ExpertPackModelResolution {
  return {
    requested: request.modelAssignment,
    resolvedModelId: modelId,
    compatibility: "experimental",
    qualificationSuiteId: manifest.qualification.suiteId,
    reason,
  };
}

function cancelled(error: unknown, signal?: AbortSignal) {
  return signal?.aborted
    || error instanceof ProviderError && error.code === "cancelled"
    || error instanceof SqlRuntimeError && error.code === "cancelled"
    || error instanceof DOMException && error.name === "AbortError";
}

function mappedFailure(request: ExpertPackRequest, error: unknown, phase: PackPhase, usage: Usage, signal?: AbortSignal) {
  if (cancelled(error, signal)) return failure(request, "cancelled", "The Analytics request was stopped.", false, usage);
  if (error instanceof ProviderError) {
    if (error.code === "timeout") return failure(request, "timeout", "The local model timed out while preparing the analysis.", true, usage);
    if (error.code === "model-missing") return failure(request, "model-missing", "The configured local model is not installed.", false, usage);
    if (error.code === "unavailable") return failure(request, "provider-unavailable", "The local model provider is unavailable.", true, usage);
    return failure(request, "provider-failure", "The local model could not prepare the analysis.", error.code === "http" || error.code === "empty-output", usage);
  }
  if (error instanceof SqlRuntimeError) {
    if (error.code === "timeout") return failure(request, "timeout", error.message, true, usage);
    if (error.code === "resource-limit") return failure(request, "resource-limit", error.message, false, usage);
    if (error.code === "invalid-query") return failure(request, "invalid-output", "The proposed analysis was not a valid read-only query.", false, usage);
    if (error.code === "dataset-changed") return failure(request, "tool-failure", error.message, false, usage);
    return failure(request, "tool-failure", "The local analytical runtime failed safely.", false, usage);
  }
  if (phase === "planning") return failure(request, "invalid-output", "The local model returned an invalid analytical plan.", false, usage);
  return failure(request, "tool-failure", "The local analytical runtime failed safely.", false, usage);
}

export async function runAnalyticsExpertPack(value: unknown, dependencies: AnalyticsPackDependencies = defaultDependencies, options: { signal?: AbortSignal } = {}): Promise<AnalyticsPackOutcome> {
  const requestValidation = validateExpertPackRequest(value, manifest);
  if (!requestValidation.valid) return invalidRequestOutcome(value, requestValidation.errors);
  const request = value as ExpertPackRequest;
  const usage = emptyUsage();
  if (options.signal?.aborted) return failure(request, "cancelled", "The Analytics request was stopped.", false, usage);

  const datasetReferences = request.contextReferences.filter((reference) => reference.kind === "dataset");
  if (datasetReferences.length !== 1) return failure(request, "permission-required", "Attach exactly one approved dataset before running Analytics.", false, usage);
  const datasetId = datasetReferences[0].id;
  const datasetGrant = request.grants.find((grant) => grant.permission === "approved-dataset:read" && grant.scope.kind === "conversation" && grant.scope.id === request.conversationId && grant.resource?.kind === "dataset" && grant.resource.id === datasetId);
  const runtimeGrant = request.grants.find((grant) => grant.permission === "local-runtime:execute" && grant.scope.kind === "request" && grant.scope.id === request.requestId);
  if (!datasetGrant || !runtimeGrant) return failure(request, "permission-required", "Analytics requires request-scoped runtime access and the exact conversation-attached dataset grant.", false, usage);

  let phase: PackPhase = "preflight";
  try {
    const configuredModel = dependencies.configuredModel();
    if (request.modelAssignment.mode === "custom" && request.modelAssignment.modelId !== configuredModel) {
      return failure(request, "model-unqualified", "Custom Analytics model switching is not enabled yet; the requested model was not loaded.", false, usage);
    }
    const model = modelReceipt(request, configuredModel, request.modelAssignment.mode === "automatic"
      ? "Automatic selection reused the configured local model; Analytics qualification remains experimental."
      : "The configured general model was reused; Analytics qualification remains experimental.");

    const dataset = dependencies.getDataset(datasetId);
    if (!dataset) return failure(request, "permission-required", "That dataset is no longer approved.", false, usage);

    usage.permissions.add("approved-dataset:read");
    usage.grantIds.add(datasetGrant.id);
    phase = "identity";
    const identity = await dependencies.inspectIdentity(dataset.path, { signal: options.signal });

    usage.permissions.add("local-runtime:execute");
    usage.grantIds.add(runtimeGrant.id);
    usage.tools.add("duckdb-readonly");
    phase = "schema";
    const columns = await dependencies.inspectSchema(dataset.path, { signal: options.signal });
    const executeGrounding = (query: string) => dependencies.executeSql({ approvedDatasetPath: dataset.path, query, expectedInputSha256: identity.sha256, signal: options.signal });

    phase = "planning";
    const advanced = shouldUseAdvancedAnalyticalPlan(request.currentRequest);
    const resolved = advanced ? await compileResolvedAdvancedAnalyticalPlan(request.currentRequest, columns, dataset.path, executeGrounding) : null;
    let proposal: SqlProposal;
    let semanticPlan: Record<string, unknown>;
    if (advanced) {
      if (resolved?.proposal) {
        proposal = resolved.proposal;
        semanticPlan = resolved.plan as unknown as Record<string, unknown>;
      }
      else {
        usage.model = model;
        const compiled = await compileGroundedAdvancedAnalyticalPlan(
          await dependencies.completeJson(buildAdvancedAnalyticalMessages(request.conversation, dataset, columns), { signal: options.signal, modelId: configuredModel, jsonSchema: buildAdvancedAnalyticalSchema(request.conversation, dataset, columns), numPredict: 900 }),
          request.currentRequest, columns, dataset.path, executeGrounding,
        );
        proposal = compiled.proposal;
        semanticPlan = compiled.plan as unknown as Record<string, unknown>;
      }
    } else {
      const boundary = resolveAnalyticalBoundary(request.currentRequest);
      if (boundary) {
        semanticPlan = boundary as unknown as Record<string, unknown>;
        proposal = compileAnalyticalPlan(boundary, columns);
      }
      else {
        usage.model = model;
        const plan = normalizeAnalyticalPlan(parseAnalyticalPlan(await dependencies.completeJson(
          buildAnalyticalPlanMessages(request.conversation, dataset, columns),
          { signal: options.signal, modelId: configuredModel, jsonSchema: buildAnalyticalPlanSchema(request.conversation, dataset, columns), numPredict: 700 },
        )), request.currentRequest, columns);
        semanticPlan = plan as unknown as Record<string, unknown>;
        proposal = compileAnalyticalPlan(plan, columns);
      }
    }

    if (proposal.action !== "query") {
      return checkedOutcome(request, {
        requestId: request.requestId,
        packId: manifest.id,
        packVersion: manifest.version,
        status: "clarification",
        responseProposal: proposal.explanation,
        clarification: proposal.explanation,
        evidence: [],
        modelBackgroundClaims: [],
        warnings: [],
        receipt: receipt(usage),
      }, undefined, { plan: semanticPlan, proposal });
    }

    phase = "execution";
    const result = await dependencies.executeSql({ approvedDatasetPath: dataset.path, query: proposal.query, expectedInputSha256: identity.sha256, signal: options.signal });
    let answer: string;
    phase = "narration";
    usage.model = model;
    const warnings: Array<{ code: ExpertPackWarningCode; message: string }> = [];
    try {
      const narrated = await dependencies.completeText(buildAnalysisNarrationMessages(request.currentRequest, proposal, result), { signal: options.signal, modelId: configuredModel, numPredict: 700 });
      if (analysisNarrationIsGrounded(narrated, result)) answer = narrated;
      else {
        answer = formatVerifiedAnalysisFallback(result);
        warnings.push({ code: "narration-grounding-rejected", message: "The model narration failed the result-grounding audit, so Rangabot used a deterministic verified fallback." });
      }
    } catch (error) {
      if (cancelled(error, options.signal)) throw error;
      answer = formatVerifiedAnalysisFallback(result);
      warnings.push({ code: "model-narration-unavailable", message: "The model narration was unavailable, so Rangabot used a deterministic verified fallback." });
    }

    const trace: NonNullable<ChatMessage["analysisTrace"]> = {
      engine: "duckdb",
      dataset: dataset.name,
      query: proposal.query,
      returnedRows: result.receipt.returnedRows,
      truncated: result.receipt.truncated,
      durationMs: result.receipt.durationMs,
      inputSha256: result.receipt.input.sha256,
      querySha256: result.receipt.querySha256,
      packId: manifest.id,
      packVersion: manifest.version,
      modelMode: request.modelAssignment.mode,
      modelId: configuredModel,
    };
    return checkedOutcome(request, {
      requestId: request.requestId,
      packId: manifest.id,
      packVersion: manifest.version,
      status: "success",
      responseProposal: answer,
      evidence: [{
        id: result.receipt.querySha256,
        kind: "table",
        source: "local-execution",
        locator: `duckdb:${result.receipt.input.sha256}:${result.receipt.querySha256}`,
        claims: [`Returned ${result.receipt.returnedRows} verified row${result.receipt.returnedRows === 1 ? "" : "s"}${result.receipt.truncated ? " within the runtime row limit" : ""}.`],
        localExecution: {
          engine: "duckdb",
          resourceId: datasetId,
          inputSha256: result.receipt.input.sha256,
          querySha256: result.receipt.querySha256,
          readOnly: true,
          externalAccess: false,
          rowLimit: result.receipt.rowLimit,
          returnedRows: result.receipt.returnedRows,
          truncated: result.receipt.truncated,
          durationMs: result.receipt.durationMs,
        },
      }],
      modelBackgroundClaims: [],
      warnings,
      receipt: receipt(usage),
    }, trace, { plan: semanticPlan, proposal });
  } catch (error) {
    return mappedFailure(request, error, phase, usage, options.signal);
  }
}
