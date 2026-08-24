import { handleAnalyticsChat } from "./analytics-chat-handler.ts";
import { classifyConversationalAnalysis, repositoryPreference, shouldAutoSearchKnowledge, shouldPlanWordDocument, vaultPreference, type ConversationalAnalysisIntent, type ResourcePreference } from "./capability-intents.ts";
import { capabilityClarification, planCapabilityRoute, type CapabilityContext, type CapabilityPlan } from "./capability-router.ts";
import { formatCodeContext, type CodeContextRequest } from "./code-context.ts";
import { answerUnavailableAction, compileAnswerContract } from "./conversation-contract.ts";
import { answerDeterministicConversationRequest } from "./conversation-orchestration.ts";
import type { ConversationMode } from "./conversation-turns.ts";
import { classifyDirectMemoryRequest, declinesApprovedMemory, executeDirectMemoryRequest, type DirectMemoryRequest } from "./memories.ts";
import { auditFinishedAnswer, deriveFinishVerificationPlan, deterministicArithmeticAnswer, finishVerificationReceipt } from "./finish-verification.ts";
import { getAllowedRepository, type AllowedRepository } from "./repositories.ts";
import { previewRepositoryFile, type CodePreview } from "./repository-search.ts";
import type { ChatMessage } from "./providers/types.ts";

export type CoreChatDispatchInput = {
  messages: ChatMessage[];
  codeContext?: CodeContextRequest;
  datasetId?: string;
  conversationId?: string;
  mode?: ConversationMode;
  signal?: AbortSignal;
};

export type CoreChatDispatchDependencies = {
  safeContinuation(question: string): string | null;
  deterministic(messages: ChatMessage[]): string | null;
  classifyDirectMemory(question: string): DirectMemoryRequest | null;
  approvedMemoryAllowed(question: string): boolean;
  executeDirectMemory(request: DirectMemoryRequest): { answer: string; titles: string[] };
  getRepository(id: string): AllowedRepository | null;
  preview(repository: AllowedRepository, path: string, line: number): CodePreview;
  formatContext(repository: AllowedRepository, preview: CodePreview): string;
  analytics(input: CoreChatDispatchInput): Promise<Response | null>;
  wordRequested(messages: ChatMessage[]): boolean;
  analysisIntent(messages: ChatMessage[]): ConversationalAnalysisIntent;
  vaultRequested(question: string, mode: ConversationMode): boolean;
  vaultPreference(question: string): ResourcePreference;
  repositoryPreference(question: string): ResourcePreference;
};

export class CapabilityExecutionError extends Error {
  readonly originalError: unknown;
  readonly capabilityPlan: CapabilityPlan;
  readonly usedContexts: CapabilityContext[];
  readonly attemptedContexts: CapabilityContext[];

  constructor(
    originalError: unknown,
    capabilityPlan: CapabilityPlan,
    usedContexts: CapabilityContext[],
    attemptedContexts: CapabilityContext[] = usedContexts,
  ) {
    super(originalError instanceof Error ? originalError.message : "The selected local capability failed.", { cause: originalError });
    this.name = "CapabilityExecutionError";
    this.originalError = originalError;
    this.capabilityPlan = capabilityPlan;
    this.usedContexts = usedContexts;
    this.attemptedContexts = attemptedContexts;
  }
}

const defaultDependencies: CoreChatDispatchDependencies = {
  safeContinuation: (question) => answerUnavailableAction(question)?.answer ?? null,
  deterministic: answerDeterministicConversationRequest,
  classifyDirectMemory: classifyDirectMemoryRequest,
  approvedMemoryAllowed: (question) => !declinesApprovedMemory(question),
  executeDirectMemory: executeDirectMemoryRequest,
  getRepository: getAllowedRepository,
  preview: previewRepositoryFile,
  formatContext: formatCodeContext,
  analytics: handleAnalyticsChat,
  wordRequested: shouldPlanWordDocument,
  analysisIntent: classifyConversationalAnalysis,
  vaultRequested: (question, mode) => vaultPreference(question) === "use" || mode === "teach" || mode === "smart" && shouldAutoSearchKnowledge(question),
  vaultPreference,
  repositoryPreference,
};

function unavailableResponse() {
  return new Response("Codex handoff is not enabled yet. Nothing was sent to the cloud. Continue here in Local mode, or enable an approved handoff before trying again.", { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

export async function dispatchCoreChat(input: CoreChatDispatchInput, dependencies: CoreChatDispatchDependencies = defaultDependencies) {
  const latestQuestion = [...input.messages].reverse().find((message) => message.role === "user")?.content ?? "";
  const mode = input.mode ?? "local";
  const approvedMemoryAllowed = dependencies.approvedMemoryAllowed(latestQuestion);
  if (mode === "codex") {
    const capabilityPlan = planCapabilityRoute({ messages: input.messages, mode, hasDataset: Boolean(input.datasetId), hasCodeContext: Boolean(input.codeContext), safeContinuationAvailable: false, deterministicAvailable: false, directMemoryAvailable: false, wordRequested: false, analysisIntent: { requested: false, requiresDataset: false, explicitlyDeclined: false }, vaultRequested: false, vaultPreference: "unspecified", repositoryPreference: "unspecified" });
    return { response: unavailableResponse(), localCodeContext: null, capabilityPlan, usedContexts: [] as CapabilityContext[], attemptedContexts: [] as CapabilityContext[], approvedMemoryAllowed };
  }
  const safeContinuation = dependencies.safeContinuation(latestQuestion);
  const deterministic = dependencies.deterministic(input.messages);
  const directMemoryRequest = dependencies.classifyDirectMemory(latestQuestion);
  const capabilityPlan = planCapabilityRoute({
    messages: input.messages,
    mode,
    hasDataset: Boolean(input.datasetId),
    hasCodeContext: Boolean(input.codeContext),
    safeContinuationAvailable: Boolean(safeContinuation),
    deterministicAvailable: Boolean(deterministic),
    directMemoryAvailable: Boolean(directMemoryRequest) && approvedMemoryAllowed,
    wordRequested: dependencies.wordRequested(input.messages),
    analysisIntent: dependencies.analysisIntent(input.messages),
    vaultRequested: dependencies.vaultRequested(latestQuestion, mode),
    vaultPreference: dependencies.vaultPreference(latestQuestion),
    repositoryPreference: dependencies.repositoryPreference(latestQuestion),
  });
  if (capabilityPlan.route === "safe-continuation" && safeContinuation) {
    return {
      response: new Response(safeContinuation, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Rangabot-Response": "safe-continuation" } }),
      localCodeContext: null,
      capabilityPlan,
      usedContexts: [] as CapabilityContext[],
      attemptedContexts: [] as CapabilityContext[],
      approvedMemoryAllowed,
    };
  }
  if (capabilityPlan.route === "deterministic-answer" && deterministic) {
    const contract = compileAnswerContract(input.messages);
    const finishPlan = deriveFinishVerificationPlan(contract);
    const arithmetic = deterministicArithmeticAnswer(finishPlan);
    const headers = new Headers({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Rangabot-Response": "deterministic" });
    if (arithmetic === deterministic) headers.set("X-Rangabot-Finish", encodeURIComponent(JSON.stringify(finishVerificationReceipt(finishPlan, false, auditFinishedAnswer(deterministic, finishPlan, contract)))));
    return {
      response: new Response(deterministic, { headers }),
      localCodeContext: null,
      capabilityPlan,
      usedContexts: [] as CapabilityContext[],
      attemptedContexts: [] as CapabilityContext[],
      approvedMemoryAllowed,
    };
  }
  if (capabilityPlan.route === "direct-memory" && directMemoryRequest) {
    let memory;
    try {
      memory = dependencies.executeDirectMemory(directMemoryRequest);
    } catch (error) {
      throw new CapabilityExecutionError(error, capabilityPlan, [], ["approved-memory"]);
    }
    return {
      response: new Response(memory.answer, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "X-Rangabot-Memory": "direct",
          ...(memory.titles.length ? { "X-Rangabot-Memory-Titles": encodeURIComponent(JSON.stringify(memory.titles)) } : {}),
        },
      }),
      localCodeContext: null,
      capabilityPlan,
      usedContexts: ["approved-memory"] as CapabilityContext[],
      attemptedContexts: ["approved-memory"] as CapabilityContext[],
      approvedMemoryAllowed,
    };
  }

  if (capabilityPlan.status === "clarify") {
    return {
      response: new Response(capabilityClarification(capabilityPlan), { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }),
      localCodeContext: null,
      capabilityPlan,
      usedContexts: [] as CapabilityContext[],
      attemptedContexts: [] as CapabilityContext[],
      approvedMemoryAllowed,
    };
  }

  const usedContexts: CapabilityContext[] = [];
  const attemptedContexts: CapabilityContext[] = [];
  let localCodeContext: string | null = null;
  if (input.codeContext && capabilityPlan.requiredContexts.includes("repository")) {
    attemptedContexts.push("repository");
    let repository;
    try {
      repository = dependencies.getRepository(input.codeContext.repositoryId);
    } catch (error) {
      throw new CapabilityExecutionError(error, capabilityPlan, usedContexts, attemptedContexts);
    }
    if (!repository) return { response: Response.json({ error: "That folder is no longer approved." }, { status: 400 }), localCodeContext, capabilityPlan, usedContexts, attemptedContexts, approvedMemoryAllowed };
    try {
      localCodeContext = dependencies.formatContext(repository, dependencies.preview(repository, input.codeContext.path, input.codeContext.line));
    } catch (error) {
      throw new CapabilityExecutionError(error, capabilityPlan, usedContexts, attemptedContexts);
    }
    usedContexts.push("repository");
  }

  let analytics: Response | null = null;
  if (capabilityPlan.route === "analytics") {
    attemptedContexts.push("dataset");
    try {
      analytics = await dependencies.analytics(input);
    } catch (error) {
      throw new CapabilityExecutionError(error, capabilityPlan, usedContexts, attemptedContexts);
    }
  }
  if (analytics?.ok) usedContexts.push("dataset");
  return { response: analytics, localCodeContext, capabilityPlan, usedContexts, attemptedContexts, approvedMemoryAllowed };
}
