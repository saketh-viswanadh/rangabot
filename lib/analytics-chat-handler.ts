import { createHash } from "node:crypto";
import { issueAuthorizedAnalyticsRequest } from "./analytics-pack-control.ts";
import { runAnalyticsExpertPack, type AnalyticsPackOutcome } from "./analytics-expert-pack.ts";
import { shouldRunSqlAnalysis } from "./conversational-analysis.ts";
import { getConversation, type Conversation } from "./conversations.ts";
import { expertPackFailureStatus } from "./expert-pack-http.ts";
import type { ExpertPackRequest } from "./expert-packs.ts";
import { isValidAnalysisTrace } from "./chat-validation.ts";
import type { ChatMessage } from "./providers/types.ts";
import { getApprovedDataset } from "./datasets.ts";
import { getDatasetSemanticMemory, recordDatasetSemanticUsage, selectDatasetSemanticContext } from "./dataset-semantic-contexts.ts";

export type AnalyticsChatInput = {
  messages: ChatMessage[];
  datasetId?: string;
  conversationId?: string;
  signal?: AbortSignal;
};

export type AnalyticsChatDependencies = {
  getConversation(id: string): Conversation | null;
  issueRequest(input: {
    conversation: Conversation | null;
    conversationId: string;
    datasetId: string;
    submittedMessages: ChatMessage[];
  }): ExpertPackRequest | null;
  runPack(request: ExpertPackRequest, signal?: AbortSignal): Promise<AnalyticsPackOutcome>;
};

const defaultDependencies: AnalyticsChatDependencies = {
  getConversation,
  issueRequest: issueAuthorizedAnalyticsRequest,
  runPack: async (request, signal) => {
    const datasetId = request.grants.find((grant) => grant.permission === "approved-dataset:read" && grant.resource?.kind === "dataset")?.resource?.id;
    const dataset = datasetId ? getApprovedDataset(datasetId) : null;
    const semanticContext = dataset ? selectDatasetSemanticContext(request.currentRequest, getDatasetSemanticMemory(dataset)) : undefined;
    const outcome = await runAnalyticsExpertPack(request, undefined, { signal, semanticContext });
    if (dataset && outcome.result.status === "success" && outcome.diagnostics?.contextUsage) {
      try { recordDatasetSemanticUsage(dataset, outcome.diagnostics.contextUsage); }
      catch { /* Usage learning must never hide a verified analytical answer. */ }
    }
    return outcome;
  },
};

export function analyticsTraceMatchesOutcome(outcome: AnalyticsPackOutcome) {
  if (outcome.result.status !== "success") return outcome.trace === undefined;
  const trace = outcome.trace;
  const execution = outcome.result.evidence.find((item) => item.source === "local-execution")?.localExecution;
  const model = outcome.result.receipt.model;
  if (!isValidAnalysisTrace(trace) || !execution) return false;
  const modelMatches = model
    ? trace.modelMode === model.requested.mode && trace.modelId === model.resolvedModelId
    : trace.modelMode === undefined && trace.modelId === undefined;
  return trace.packId === outcome.result.packId
    && trace.packVersion === outcome.result.packVersion
    && modelMatches
    && trace.inputSha256 === execution.inputSha256
    && trace.querySha256 === execution.querySha256
    && createHash("sha256").update(trace.query).digest("hex") === trace.querySha256
    && trace.returnedRows === execution.returnedRows
    && trace.truncated === execution.truncated
    && trace.durationMs === execution.durationMs;
}

/**
 * Returns null when Analytics is not the selected capability. The chat route
 * deliberately calls this only after higher-precedence deterministic answers.
 */
export async function handleAnalyticsChat(input: AnalyticsChatInput, dependencies: AnalyticsChatDependencies = defaultDependencies): Promise<Response | null> {
  if (!input.datasetId || !shouldRunSqlAnalysis(input.messages)) return null;
  if (!input.conversationId) return Response.json({ error: "Analytics requires the current saved conversation." }, { status: 400 });
  const conversation = dependencies.getConversation(input.conversationId);
  const request = dependencies.issueRequest({
    conversation,
    conversationId: input.conversationId,
    datasetId: input.datasetId,
    submittedMessages: input.messages,
  });
  if (!request) return Response.json({ error: "That dataset is not attached to this conversation." }, { status: 400 });
  const outcome = await dependencies.runPack(request, input.signal);
  if (!outcome.result.responseProposal) {
    const code = outcome.result.error?.code;
    return Response.json(
      { error: outcome.result.error?.message ?? "The Analytics Pack could not complete this request.", ...(code ? { code } : {}) },
      { status: expertPackFailureStatus(code) },
    );
  }
  if (!analyticsTraceMatchesOutcome(outcome)) {
    return Response.json({ error: "The Analytics Pack returned inconsistent execution provenance.", code: "invalid-output" }, { status: 500 });
  }
  return new Response(outcome.result.responseProposal, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Content-Type-Options": "nosniff",
      ...(outcome.trace ? { "X-Rangabot-Analysis": encodeURIComponent(JSON.stringify(outcome.trace)) } : {}),
      ...(outcome.result.warnings.length ? { "X-Rangabot-Pack-Warnings": outcome.result.warnings.map((warning) => warning.code).join(",") } : {}),
    },
  });
}
