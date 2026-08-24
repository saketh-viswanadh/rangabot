import type { ConversationalAnalysisIntent, ResourcePreference } from "./capability-intents.ts";
import type { ConversationMode } from "./conversation-turns.ts";
import type { ChatMessage } from "./providers/types.ts";

export const CAPABILITY_ROUTE_VERSION = "capability-route-v1" as const;

export type CapabilityRoute =
  | "safe-continuation"
  | "deterministic-answer"
  | "direct-memory"
  | "analytics"
  | "word-document"
  | "knowledge-vault"
  | "repository-context"
  | "conversation"
  | "clarification"
  | "unavailable";

export type CapabilityContext = "dataset" | "repository" | "knowledge-vault" | "approved-memory";
export type CapabilityReason =
  | "external-action-unavailable"
  | "deterministic-contract"
  | "explicit-memory-recall"
  | "attached-data-analysis"
  | "missing-required-dataset"
  | "explicit-word-artifact"
  | "explicit-vault-request"
  | "teacher-mode"
  | "smart-vault-match"
  | "attached-repository-context"
  | "ordinary-conversation"
  | "multiple-material-capabilities"
  | "cloud-handoff-disabled";

type MaterialRoute = "analytics" | "word-document" | "knowledge-vault" | "repository-context";

export type CapabilityPlan = {
  version: typeof CAPABILITY_ROUTE_VERSION;
  status: "selected" | "clarify" | "unavailable";
  route: CapabilityRoute;
  requiredContexts: CapabilityContext[];
  reasons: CapabilityReason[];
  clarification?: "attach-dataset" | "choose-capability";
  candidates?: MaterialRoute[];
};

export type CapabilityReceipt = {
  version: typeof CAPABILITY_ROUTE_VERSION;
  status: CapabilityPlan["status"];
  route: CapabilityRoute;
  contexts: CapabilityContext[];
  attemptedContexts: CapabilityContext[];
  reasons: CapabilityReason[];
};

export type CapabilityRouterInput = {
  messages: ChatMessage[];
  mode: ConversationMode;
  hasDataset: boolean;
  hasCodeContext: boolean;
  safeContinuationAvailable: boolean;
  deterministicAvailable: boolean;
  directMemoryAvailable: boolean;
  wordRequested: boolean;
  analysisIntent: ConversationalAnalysisIntent;
  vaultRequested: boolean;
  vaultPreference: ResourcePreference;
  repositoryPreference: ResourcePreference;
};

function unique<T>(values: T[]): T[] { return [...new Set(values)]; }

function selected(route: Exclude<CapabilityRoute, "clarification" | "unavailable">, requiredContexts: CapabilityContext[], reasons: CapabilityReason[]): CapabilityPlan {
  return { version: CAPABILITY_ROUTE_VERSION, status: "selected", route, requiredContexts: unique(requiredContexts), reasons: unique(reasons) };
}

export function planCapabilityRoute(input: CapabilityRouterInput): CapabilityPlan {
  if (input.mode === "codex") {
    return { version: CAPABILITY_ROUTE_VERSION, status: "unavailable", route: "unavailable", requiredContexts: [], reasons: ["cloud-handoff-disabled"] };
  }
  if (input.safeContinuationAvailable) return selected("safe-continuation", [], ["external-action-unavailable"]);
  if (input.deterministicAvailable) return selected("deterministic-answer", [], ["deterministic-contract"]);
  if (input.directMemoryAvailable) return selected("direct-memory", ["approved-memory"], ["explicit-memory-recall"]);

  const analysisRequested = input.analysisIntent.requested && !input.analysisIntent.explicitlyDeclined;
  if (analysisRequested && input.analysisIntent.requiresDataset && !input.hasDataset) {
    return {
      version: CAPABILITY_ROUTE_VERSION,
      status: "clarify",
      route: "clarification",
      requiredContexts: ["dataset"],
      reasons: ["missing-required-dataset"],
      clarification: "attach-dataset",
    };
  }

  const analyticsRequested = input.hasDataset && analysisRequested
    && (input.analysisIntent.requiresDataset || input.analysisIntent.attachmentCandidate === true);
  const explicitVault = input.vaultPreference === "use";
  const vaultRequested = input.vaultPreference !== "ignore" && input.vaultRequested;
  const repositoryRequested = input.hasCodeContext && input.repositoryPreference === "use";
  const conflicting: MaterialRoute[] = [];
  if (analyticsRequested) conflicting.push("analytics");
  if (input.wordRequested) conflicting.push("word-document");
  if (explicitVault) conflicting.push("knowledge-vault");
  if (analyticsRequested && repositoryRequested) conflicting.push("repository-context");
  const candidates = unique(conflicting);
  if (candidates.length > 1) {
    return {
      version: CAPABILITY_ROUTE_VERSION,
      status: "clarify",
      route: "clarification",
      requiredContexts: unique<CapabilityContext>([
        ...(candidates.includes("analytics") ? ["dataset" as const] : []),
        ...(candidates.includes("knowledge-vault") ? ["knowledge-vault" as const] : []),
        ...(candidates.includes("repository-context") ? ["repository" as const] : []),
      ]),
      reasons: ["multiple-material-capabilities"],
      clarification: "choose-capability",
      candidates,
    };
  }

  if (input.wordRequested) {
    return selected(
      "word-document",
      repositoryRequested ? ["repository"] : [],
      ["explicit-word-artifact", ...(repositoryRequested ? ["attached-repository-context" as const] : [])],
    );
  }
  if (analyticsRequested) return selected("analytics", ["dataset"], ["attached-data-analysis"]);
  if (vaultRequested) {
    return selected(
      "knowledge-vault",
      ["knowledge-vault", ...(repositoryRequested ? ["repository" as const] : [])],
      [explicitVault ? "explicit-vault-request" : input.mode === "teach" ? "teacher-mode" : "smart-vault-match", ...(repositoryRequested ? ["attached-repository-context" as const] : [])],
    );
  }
  if (input.hasCodeContext && input.repositoryPreference === "use") {
    return selected("repository-context", ["repository"], ["attached-repository-context"]);
  }
  return selected("conversation", [], ["ordinary-conversation"]);
}

const candidateLabels: Record<MaterialRoute, string> = {
  analytics: "analyze the attached data",
  "word-document": "create a Word document",
  "knowledge-vault": "answer from the local Knowledge Vault",
  "repository-context": "use the attached code excerpt",
};

export function capabilityClarification(plan: CapabilityPlan): string | null {
  if (plan.status !== "clarify") return null;
  if (plan.clarification === "attach-dataset") {
    return "I don't have an approved dataset attached to this chat. Attach the CSV, Parquet, or DuckDB file you want me to analyze, then ask again.";
  }
  const labels = (plan.candidates ?? []).map((candidate) => candidateLabels[candidate]);
  if (labels.length > 1) {
    const choices = labels.length === 2 ? `${labels[0]} or ${labels[1]}` : `${labels.slice(0, -1).join(", ")}, or ${labels.at(-1)}`;
    return `I can use one governed capability at a time. Should I ${choices}? No attached resource has been opened yet.`;
  }
  return "Which single local capability should I use first? No attached resource has been opened yet.";
}

export function capabilityReceipt(plan: CapabilityPlan, contexts: CapabilityContext[] = [], attemptedContexts: CapabilityContext[] = contexts): CapabilityReceipt {
  return {
    version: plan.version,
    status: plan.status,
    route: plan.route,
    contexts: unique(contexts),
    attemptedContexts: unique(attemptedContexts),
    reasons: plan.reasons,
  };
}
