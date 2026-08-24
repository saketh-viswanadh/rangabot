import { createHash } from "node:crypto";
import { buildAdvancedAnalyticalMessages, buildAdvancedAnalyticalSchema, compileAdvancedAnalyticalPlan, shouldUseAdvancedAnalyticalPlan } from "./advanced-analytical-plan.ts";
import { buildAnalyticalPlanMessages, buildAnalyticalPlanSchema, compileAnalyticalPlan, normalizeAnalyticalPlan, parseAnalyticalPlan, resolveAnalyticalBoundary } from "./analytical-plan.ts";
import { compileGroundedAdvancedAnalyticalPlan, compileResolvedAdvancedAnalyticalPlan } from "./analytical-filter-grounding.ts";
import { auditGeneralSqlPlan, buildGeneralSqlMessages, buildGeneralSqlSchema, compileGeneralSqlPlan, parseGeneralSqlPlan, resolveGeneralSqlPlan, shouldUseGeneralSqlPlan } from "./general-sql-plan.ts";
import { compileExpertRelationalPlan, resolveExpertRelationalPlan, shouldUseExpertRelationalPlan } from "./expert-relational-plan.ts";
import { auditVerifiedAnalyticalNarration, compileVerifiedAnalyticalNarration, type ResolvedAnalyticalPlan, type VerifiedAnalyticalNarration, type VerifiedAnalyticalNarrationAudit } from "./analytical-narration.ts";
import { auditAnalyticalIntent } from "./analytical-intent-contract.ts";
import { getApprovedDataset, type ApprovedDataset } from "./datasets.ts";
import { getExpertPackManifest } from "./expert-pack-registry.ts";
import { type ExpertPackFailureCode, type ExpertPackManifest, type ExpertPackModelResolution, type ExpertPackPermission, type ExpertPackRequest, type ExpertPackResult, type ExpertPackWarningCode, validateExpertPackRequest, validateExpertPackResult } from "./expert-packs.ts";
import { selectedChatModel } from "./model-manager.ts";
import { planOpenWorldSql } from "./open-world-sql-planner.ts";
import { completeJsonWithOllama } from "./providers/ollama.ts";
import { ProviderError, type ChatMessage, type GenerationOptions } from "./providers/types.ts";
import { resolveSchemaGroundedPhaseOnePlan } from "./schema-grounded-phase-one.ts";
import { applyAnalyticalSemanticContext, type AnalyticalSemanticContext } from "./analytical-semantic-context.ts";
import { verifiedSqlUsage } from "./dataset-semantic-contexts.ts";
import { focusDatabaseSchema, type SqlProposal } from "./sql-proposals.ts";
import { executeReadOnlySql, inspectDatasetIdentity, inspectDatasetSchema, SqlRuntimeError, type DatasetColumn, type DatasetFileIdentity, type SqlExecutionResult } from "./sql-runtime.ts";

function requireManifest(): ExpertPackManifest {
  const installed = getExpertPackManifest("analytics");
  if (!installed) throw new Error("The bundled Analytics Expert Pack manifest is missing.");
  return installed;
}

const manifest = requireManifest();

export type AnalyticsPackDependencies = {
  getDataset(id: string): ApprovedDataset | null;
  inspectIdentity(path: string, options?: { signal?: AbortSignal; expectedFileIdentity?: DatasetFileIdentity }): ReturnType<typeof inspectDatasetIdentity>;
  inspectSchema(path: string, options?: { signal?: AbortSignal; expectedFileIdentity?: DatasetFileIdentity; expectedInputSha256?: string }): Promise<DatasetColumn[]>;
  completeJson(messages: ChatMessage[], options?: GenerationOptions): Promise<string>;
  executeSql(input: { approvedDatasetPath: string; query: string; expectedFileIdentity?: DatasetFileIdentity; expectedInputSha256?: string; signal?: AbortSignal }): Promise<SqlExecutionResult>;
  configuredModel(): string;
};

const defaultDependencies: AnalyticsPackDependencies = {
  getDataset: getApprovedDataset,
  inspectIdentity: inspectDatasetIdentity,
  inspectSchema: inspectDatasetSchema,
  completeJson: completeJsonWithOllama,
  executeSql: executeReadOnlySql,
  configuredModel: selectedChatModel,
};

export type AnalyticsPackOutcome = {
  result: ExpertPackResult;
  trace?: NonNullable<ChatMessage["analysisTrace"]>;
  /** Private evaluator seam; never serialized by the chat route. */
  diagnostics?: {
    plan: Record<string, unknown>;
    proposal: SqlProposal;
    execution?: SqlExecutionResult;
    contextUsage?: { tables: string[]; columns: string[] };
    narration?: {
      disposition: "trusted-renderer";
      narrative: VerifiedAnalyticalNarration;
      audit: VerifiedAnalyticalNarrationAudit;
    };
  };
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
  const reason = signal?.aborted ? signal.reason : undefined;
  return (signal?.aborted && !(reason instanceof DOMException && reason.name === "TimeoutError") && failureCode(reason) !== "timeout")
    || error instanceof ProviderError && error.code === "cancelled"
    || error instanceof SqlRuntimeError && error.code === "cancelled"
    || error instanceof DOMException && error.name === "AbortError";
}

function timedOut(error: unknown, signal?: AbortSignal) {
  const reason = signal?.aborted ? signal.reason : undefined;
  return error instanceof DOMException && error.name === "TimeoutError"
    || reason instanceof DOMException && reason.name === "TimeoutError"
    || failureCode(error) === "timeout"
    || failureCode(reason) === "timeout";
}

function throwIfCancelled(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("The Analytics request was stopped.", "AbortError");
}

function queryDigest(query: string) {
  return createHash("sha256").update(query.trim().replace(/;\s*$/, "")).digest("hex");
}

function validateExecutionReceipt(
  result: SqlExecutionResult,
  identity: { filename: string; sha256: string; sizeBytes: number },
  query: string,
) {
  const receipt = result?.receipt;
  const valid = result && Array.isArray(result.columns) && result.columns.every((column) => typeof column === "string")
    && Array.isArray(result.rows) && result.rows.every((row) => Array.isArray(row))
    && receipt?.engine === "duckdb"
    && receipt.input?.filename === identity.filename
    && receipt.input?.sha256 === identity.sha256
    && receipt.input?.sizeBytes === identity.sizeBytes
    && receipt.querySha256 === queryDigest(query)
    && receipt.readOnly === true
    && receipt.externalAccess === false
    && Number.isInteger(receipt.rowLimit) && receipt.rowLimit > 0 && receipt.rowLimit <= 200
    && Number.isInteger(receipt.returnedRows) && receipt.returnedRows === result.rows.length && receipt.returnedRows <= receipt.rowLimit
    && typeof receipt.truncated === "boolean" && (!receipt.truncated || receipt.returnedRows === receipt.rowLimit)
    && Number.isFinite(receipt.durationMs) && receipt.durationMs >= 0;
  if (!valid) throw new SqlRuntimeError("tool-failure", "The local analytical runtime returned evidence that did not match the approved dataset and query.");
}

function failureCode(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
}

function mappedFailure(request: ExpertPackRequest, error: unknown, phase: PackPhase, usage: Usage, signal?: AbortSignal) {
  if (timedOut(error, signal)) return failure(request, "timeout", phase === "planning" || phase === "narration" ? "The local model or analytical grounding timed out." : "The local analytical runtime timed out.", true, usage);
  if (cancelled(error, signal)) return failure(request, "cancelled", "The Analytics request was stopped.", false, usage);
  const code = failureCode(error);
  if (error instanceof ProviderError || ["unavailable", "model-missing", "busy", "http", "empty-output", "invalid-stream", "resource-limit"].includes(code ?? "")) {
    if (code === "model-missing") return failure(request, "model-missing", "The configured local model is not installed.", false, usage);
    if (code === "unavailable") return failure(request, "provider-unavailable", "The local model provider is unavailable.", true, usage);
    if (code === "busy") return failure(request, "provider-failure", "The selected local model is busy. Try again after the active answer finishes.", true, usage);
    if (code === "resource-limit") return failure(request, "resource-limit", error instanceof Error ? error.message : "The local model response exceeded the safe output limit.", false, usage);
    return failure(request, "provider-failure", "The local model could not prepare the analysis.", code === "http" || code === "empty-output", usage);
  }
  if (error instanceof SqlRuntimeError || ["resource-limit", "invalid-query", "dataset-changed", "tool-failure"].includes(code ?? "")) {
    if (code === "resource-limit") return failure(request, "resource-limit", error instanceof Error ? error.message : "The local analytical resource limit was reached.", false, usage);
    if (code === "invalid-query") return failure(request, "invalid-output", "The proposed analysis was not a valid read-only query.", false, usage);
    if (code === "dataset-changed") return failure(request, "tool-failure", error instanceof Error ? error.message : "The approved dataset changed during analysis.", false, usage);
    return failure(request, "tool-failure", "The local analytical runtime failed safely.", false, usage);
  }
  if (phase === "planning") return failure(request, "invalid-output", "The local model returned an invalid analytical plan.", false, usage);
  return failure(request, "tool-failure", "The local analytical runtime failed safely.", false, usage);
}

export async function runAnalyticsExpertPack(value: unknown, dependencies: AnalyticsPackDependencies = defaultDependencies, options: { signal?: AbortSignal; semanticContext?: AnalyticalSemanticContext } = {}): Promise<AnalyticsPackOutcome> {
  const requestValidation = validateExpertPackRequest(value, manifest);
  if (!requestValidation.valid) return invalidRequestOutcome(value, requestValidation.errors);
  const request = value as ExpertPackRequest;
  const usage = emptyUsage();
  if (options.signal?.aborted) return mappedFailure(request, options.signal.reason, "preflight", usage, options.signal);

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
    const identity = await dependencies.inspectIdentity(dataset.path, { signal: options.signal, expectedFileIdentity: dataset.fileIdentity });
    throwIfCancelled(options.signal);

    usage.permissions.add("local-runtime:execute");
    usage.grantIds.add(runtimeGrant.id);
    usage.tools.add("duckdb-readonly");
    phase = "schema";
    const inspectedColumns = await dependencies.inspectSchema(dataset.path, {
      signal: options.signal,
      expectedFileIdentity: dataset.fileIdentity,
      expectedInputSha256: identity.sha256,
    });
    const appliedSemanticContext = applyAnalyticalSemanticContext(inspectedColumns, options.semanticContext);
    const columns = appliedSemanticContext.columns;
    throwIfCancelled(options.signal);
    const executeGrounding = async (query: string) => {
      const grounded = await dependencies.executeSql({ approvedDatasetPath: dataset.path, query, expectedFileIdentity: dataset.fileIdentity, expectedInputSha256: identity.sha256, signal: options.signal });
      throwIfCancelled(options.signal);
      validateExecutionReceipt(grounded, identity, query);
      return grounded;
    };

    phase = "planning";
    const boundary = resolveAnalyticalBoundary(request.currentRequest);
    const contextOpenWorld = !boundary && Boolean(appliedSemanticContext.prompt);
    if (contextOpenWorld) usage.model = model;
    const phaseOne = boundary ? null : await resolveSchemaGroundedPhaseOnePlan(request.currentRequest, columns, executeGrounding);
    const expert = !boundary && !phaseOne && shouldUseExpertRelationalPlan(request.currentRequest);
    // Advanced operations carry population/relationship semantics that a
    // general aggregate can superficially imitate while answering a different
    // question. Give their typed decomposer precedence; window/ranking grammar
    // remains on the general route when no advanced intent is present.
    const advanced = !boundary && !phaseOne && !expert && shouldUseAdvancedAnalyticalPlan(request.currentRequest);
    const general = !boundary && !phaseOne && !expert && !advanced && shouldUseGeneralSqlPlan(request.currentRequest);
    const resolved = advanced ? await compileResolvedAdvancedAnalyticalPlan(request.currentRequest, columns, dataset.path, executeGrounding) : null;
    let proposal: SqlProposal;
    let semanticPlan: Record<string, unknown>;
    let resolvedPlan: ResolvedAnalyticalPlan | undefined;
    let preexecutedResult: SqlExecutionResult | undefined;
    if (boundary) {
      proposal = compileAnalyticalPlan(boundary, columns);
      resolvedPlan = { kind: "basic", plan: boundary };
      semanticPlan = boundary as unknown as Record<string, unknown>;
    }
    else if (phaseOne) {
      proposal = phaseOne.kind === "general"
        ? compileGeneralSqlPlan(phaseOne.plan, columns)
        : compileAdvancedAnalyticalPlan(phaseOne.plan, columns);
      resolvedPlan = phaseOne.kind === "general"
        ? { kind: "general", plan: phaseOne.plan }
        : { kind: "advanced", plan: phaseOne.plan };
      semanticPlan = { ...(phaseOne.plan as unknown as Record<string, unknown>), semanticGrounding: phaseOne.grounding };
    }
    else if (expert) {
      const expertPlan = resolveExpertRelationalPlan(request.currentRequest, columns);
      if (!expertPlan) {
        const missingPivotYear = /\b(?:pivot|cross[- ]tab)\b/i.test(request.currentRequest)
          && /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(request.currentRequest)
          && !/\b\d{4}\b/.test(request.currentRequest);
        const ambiguousYearOverYear = /\byear[- ]over[- ]year\b/i.test(request.currentRequest);
        proposal = { action: "clarify", query: "", explanation: missingPivotYear
          ? "Which year should the named months use? Add the year so the period boundaries are explicit."
          : ambiguousYearOverYear
            ? "Which approved relation and date field define the year-over-year measure?"
            : "Which approved relations and fields define this expert analytical operation?" };
        semanticPlan = { action: "clarify", explanation: proposal.explanation };
      } else {
        proposal = compileExpertRelationalPlan(expertPlan, columns);
        resolvedPlan = { kind: "expert", plan: expertPlan };
        semanticPlan = expertPlan as unknown as Record<string, unknown>;
      }
    }
    else if (general) {
      const resolvedGeneral = resolveGeneralSqlPlan(request.currentRequest, focusDatabaseSchema(columns, request.currentRequest));
      if (!resolvedGeneral && !contextOpenWorld) usage.model = model;
      const generalPlan = resolvedGeneral ?? (contextOpenWorld ? null : auditGeneralSqlPlan(parseGeneralSqlPlan(await dependencies.completeJson(
          buildGeneralSqlMessages(request.conversation, dataset, columns),
          { signal: options.signal, modelId: configuredModel, jsonSchema: buildGeneralSqlSchema(request.conversation, dataset, columns), numPredict: 1_200 },
        )), request.currentRequest, columns));
      if (generalPlan) {
        proposal = compileGeneralSqlPlan(generalPlan, columns);
        resolvedPlan = { kind: "general", plan: generalPlan };
        semanticPlan = generalPlan as unknown as Record<string, unknown>;
      } else {
        proposal = { action: "clarify", query: "", explanation: "The typed grammar deferred this context-grounded request to verified direct SQL planning." };
        semanticPlan = { action: "defer", route: "semantic-context-open-world" };
      }
    }
    else if (advanced) {
      if (resolved?.proposal) {
        proposal = resolved.proposal;
        resolvedPlan = { kind: "advanced", plan: resolved.plan };
        semanticPlan = resolved.plan as unknown as Record<string, unknown>;
      }
      else if (!contextOpenWorld) {
        usage.model = model;
        const compiled = await compileGroundedAdvancedAnalyticalPlan(
          await dependencies.completeJson(buildAdvancedAnalyticalMessages(request.conversation, dataset, columns), { signal: options.signal, modelId: configuredModel, jsonSchema: buildAdvancedAnalyticalSchema(request.conversation, dataset, columns), numPredict: 900 }),
          request.currentRequest, columns, dataset.path, executeGrounding,
        );
        proposal = compiled.proposal;
        resolvedPlan = { kind: "advanced", plan: compiled.plan };
        semanticPlan = compiled.plan as unknown as Record<string, unknown>;
      } else {
        proposal = { action: "clarify", query: "", explanation: "The typed grammar deferred this context-grounded request to verified direct SQL planning." };
        semanticPlan = { action: "defer", route: "semantic-context-open-world" };
      }
    } else if (!contextOpenWorld) {
      usage.model = model;
      const plan = normalizeAnalyticalPlan(parseAnalyticalPlan(await dependencies.completeJson(
        buildAnalyticalPlanMessages(request.conversation, dataset, columns),
        { signal: options.signal, modelId: configuredModel, jsonSchema: buildAnalyticalPlanSchema(request.conversation, dataset, columns), numPredict: 700 },
      )), request.currentRequest, columns);
      semanticPlan = plan as unknown as Record<string, unknown>;
      resolvedPlan = { kind: "basic", plan };
      proposal = compileAnalyticalPlan(plan, columns);
    } else {
      proposal = { action: "clarify", query: "", explanation: "The typed grammar deferred this context-grounded request to verified direct SQL planning." };
      semanticPlan = { action: "defer", route: "semantic-context-open-world" };
    }

    // The bounded typed planners remain the fastest and most auditable path for
    // requests they resolve deterministically. When a local model was already
    // required, add a schema/value-grounded direct-SQL path and bounded
    // execution feedback instead of trusting one narrow typed-plan sample.
    if (usage.model) {
      try {
        const openWorld = await planOpenWorldSql({
          request: request.currentRequest,
          columns,
          modelId: configuredModel,
          dependencies: {
            completeJson: (messages, generation) => dependencies.completeJson(messages, generation),
            executeSql: async (query) => executeGrounding(query),
          },
          ...(proposal.action === "query" ? { typedCandidate: { query: proposal.query, explanation: proposal.explanation } } : {}),
          ...(appliedSemanticContext.prompt ? { semanticContext: appliedSemanticContext.prompt } : {}),
          signal: options.signal,
        });
        semanticPlan = { typedPlan: semanticPlan, semanticContext: appliedSemanticContext.evidence, openWorld };
        if (openWorld.action === "query" && openWorld.selected) {
          const typedWon = openWorld.selected.source === "typed" && proposal.action === "query" && openWorld.selected.query === proposal.query;
          proposal = { action: "query", query: openWorld.selected.query, explanation: openWorld.selected.explanation };
          preexecutedResult = openWorld.selected.execution;
          if (!typedWon) resolvedPlan = { kind: "direct", plan: { explanation: openWorld.selected.explanation, outputColumns: preexecutedResult.columns } };
        } else if (proposal.action !== "query") {
          proposal = { action: openWorld.action, query: "", explanation: openWorld.explanation };
        }
      } catch (error) {
        // This is a measured improvement layer over the existing typed plan.
        // A malformed optional candidate document must not erase an otherwise
        // valid typed query; cancellation and timeout still win immediately.
        if (timedOut(error, options.signal) || cancelled(error, options.signal) || proposal.action !== "query") throw error;
      }
    }

    if (proposal.action === "query" && resolvedPlan && resolvedPlan.kind !== "direct") {
      const intentAudit = auditAnalyticalIntent(request.currentRequest, resolvedPlan);
      if (!intentAudit.valid) {
        proposal = { action: "clarify", query: "", explanation: intentAudit.explanation };
        semanticPlan = { ...semanticPlan, intentContract: intentAudit.expected, intentContractValid: false };
      }
    }

    throwIfCancelled(options.signal);
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

    if (!resolvedPlan) throw new Error("The Analytics Pack lost its typed analytical plan.");
    phase = "execution";
    const result = preexecutedResult ?? await dependencies.executeSql({ approvedDatasetPath: dataset.path, query: proposal.query, expectedFileIdentity: dataset.fileIdentity, expectedInputSha256: identity.sha256, signal: options.signal });
    throwIfCancelled(options.signal);
    validateExecutionReceipt(result, identity, proposal.query);
    phase = "narration";
    const narrative = compileVerifiedAnalyticalNarration(resolvedPlan, result);
    const narrativeAudit = auditVerifiedAnalyticalNarration(narrative, resolvedPlan, result);
    if (!narrativeAudit.valid) throw new Error(`The trusted analytical renderer failed closed: ${narrativeAudit.failures.join(", ")}`);
    const answer = narrative.answer;
    const warnings: Array<{ code: ExpertPackWarningCode; message: string }> = [];
    throwIfCancelled(options.signal);

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
      ...(usage.model ? { modelMode: request.modelAssignment.mode, modelId: configuredModel } : {}),
    };
    const contextUsage = verifiedSqlUsage(proposal.query, inspectedColumns);
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
        claims: narrative.claims,
        localExecution: {
          engine: "duckdb",
          resourceId: datasetId,
          inputSha256: result.receipt.input.sha256,
          querySha256: result.receipt.querySha256,
          readOnly: result.receipt.readOnly,
          externalAccess: result.receipt.externalAccess,
          rowLimit: result.receipt.rowLimit,
          returnedRows: result.receipt.returnedRows,
          truncated: result.receipt.truncated,
          durationMs: result.receipt.durationMs,
        },
      }],
      modelBackgroundClaims: [],
      warnings,
      receipt: receipt(usage),
    }, trace, { plan: semanticPlan, proposal, execution: result, contextUsage, narration: { disposition: "trusted-renderer", narrative, audit: narrativeAudit } });
  } catch (error) {
    return mappedFailure(request, error, phase, usage, options.signal);
  }
}
