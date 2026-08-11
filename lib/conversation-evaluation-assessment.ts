import {
  conversationEvaluationCapabilityOrder,
  conversationEvaluationCases,
  conversationEvaluationSuite,
  type ConversationEvaluationCapability,
} from "./conversation-evaluation-suite.ts";

export const conversationEvaluationExitPolicy = {
  suiteVersion: conversationEvaluationSuite.version,
  fullCaseCount: conversationEvaluationCases.length,
  criticalCaseCount: conversationEvaluationCases.filter((testCase) => testCase.critical).length,
  minimumFullPasses: 54,
  casesPerCapability: 5,
  minimumCapabilityPasses: 4,
} as const;

export type ConversationEvaluationAssessmentInput = {
  suite: { version: string };
  selection: {
    completeSuite: boolean;
    criticalOnly: boolean;
    requestedIds: string[];
  };
  totals: {
    passed: number;
    total: number;
    completed: number;
    errors: number;
  };
  critical: {
    passed: number;
    total: number;
  };
  byCapability: Partial<Record<ConversationEvaluationCapability, {
    passed: number;
    total: number;
  }>>;
};

export type ConversationEvaluationAssessment = {
  scope: "full" | "critical-only" | "selected" | "invalid";
  passed: boolean;
  failures: string[];
};

function isCount(value: number) {
  return Number.isInteger(value) && value >= 0;
}

export function assessConversationEvaluation(
  input: ConversationEvaluationAssessmentInput,
): ConversationEvaluationAssessment {
  const failures: string[] = [];
  const requestedIds = input.selection.requestedIds;
  let scope: ConversationEvaluationAssessment["scope"] = "invalid";

  if (requestedIds.length > 0) {
    scope = "selected";
    if (input.selection.completeSuite || input.selection.criticalOnly) {
      failures.push("Explicit case selection cannot also be marked complete-suite or critical-only.");
    }
  } else if (input.selection.completeSuite && !input.selection.criticalOnly) {
    scope = "full";
  } else if (!input.selection.completeSuite && input.selection.criticalOnly) {
    scope = "critical-only";
  } else {
    failures.push("Evaluation selection does not identify a supported full, critical-only, or explicit-case scope.");
  }

  if (input.suite.version !== conversationEvaluationExitPolicy.suiteVersion) {
    failures.push(`Suite must be frozen version ${conversationEvaluationExitPolicy.suiteVersion}.`);
  }

  const counts = [
    ["totals.passed", input.totals.passed],
    ["totals.total", input.totals.total],
    ["totals.completed", input.totals.completed],
    ["totals.errors", input.totals.errors],
    ["critical.passed", input.critical.passed],
    ["critical.total", input.critical.total],
  ] as const;
  for (const [label, value] of counts) {
    if (!isCount(value)) failures.push(`${label} must be a non-negative integer.`);
  }
  if (input.totals.passed > input.totals.total) failures.push("Passed cases cannot exceed total cases.");
  if (input.totals.completed > input.totals.total) failures.push("Completed cases cannot exceed total cases.");
  if (input.critical.passed > input.critical.total) failures.push("Passed critical cases cannot exceed total critical cases.");
  if (input.critical.total > input.totals.total) failures.push("Critical cases cannot exceed total cases.");
  if (input.totals.errors !== input.totals.total - input.totals.completed) {
    failures.push("Error count must equal total cases minus completed cases.");
  }
  if (input.totals.errors !== 0 || input.totals.completed !== input.totals.total) {
    failures.push("Every selected case must complete without an execution error.");
  }

  if (scope === "full") {
    if (input.totals.total !== conversationEvaluationExitPolicy.fullCaseCount) {
      failures.push(`Full evaluation must contain exactly ${conversationEvaluationExitPolicy.fullCaseCount} cases.`);
    }
    if (input.totals.passed < conversationEvaluationExitPolicy.minimumFullPasses) {
      failures.push(`Full evaluation must pass at least ${conversationEvaluationExitPolicy.minimumFullPasses}/${conversationEvaluationExitPolicy.fullCaseCount} cases.`);
    }
    if (
      input.critical.total !== conversationEvaluationExitPolicy.criticalCaseCount
      || input.critical.passed !== conversationEvaluationExitPolicy.criticalCaseCount
    ) {
      failures.push(`Full evaluation must pass all ${conversationEvaluationExitPolicy.criticalCaseCount} critical cases.`);
    }
    const capabilityKeys = Object.keys(input.byCapability);
    if (
      capabilityKeys.length !== conversationEvaluationCapabilityOrder.length
      || capabilityKeys.some((key) => !conversationEvaluationCapabilityOrder.includes(key as ConversationEvaluationCapability))
    ) {
      failures.push("Full evaluation must report exactly the twelve frozen capabilities.");
    }
    for (const capability of conversationEvaluationCapabilityOrder) {
      const result = input.byCapability[capability];
      if (!result || result.total !== conversationEvaluationExitPolicy.casesPerCapability) {
        failures.push(`${capability} must contain exactly ${conversationEvaluationExitPolicy.casesPerCapability} cases.`);
      } else if (!isCount(result.passed) || result.passed > result.total) {
        failures.push(`${capability} has invalid pass counts.`);
      } else if (result.passed < conversationEvaluationExitPolicy.minimumCapabilityPasses) {
        failures.push(`${capability} must pass at least ${conversationEvaluationExitPolicy.minimumCapabilityPasses}/${conversationEvaluationExitPolicy.casesPerCapability} cases.`);
      }
    }
  } else if (scope === "critical-only") {
    if (
      input.totals.total !== conversationEvaluationExitPolicy.criticalCaseCount
      || input.totals.passed !== conversationEvaluationExitPolicy.criticalCaseCount
      || input.critical.total !== conversationEvaluationExitPolicy.criticalCaseCount
      || input.critical.passed !== conversationEvaluationExitPolicy.criticalCaseCount
    ) {
      failures.push(`Critical-only evaluation must pass exactly ${conversationEvaluationExitPolicy.criticalCaseCount}/${conversationEvaluationExitPolicy.criticalCaseCount} critical cases.`);
    }
  } else if (scope === "selected") {
    if (new Set(requestedIds).size !== requestedIds.length) failures.push("Explicit case IDs must be unique.");
    if (input.totals.total !== requestedIds.length) failures.push("Explicit selection total must match the requested case count.");
    if (input.totals.passed !== input.totals.total) failures.push("Every explicitly selected case must pass.");
  }

  return { scope, passed: failures.length === 0, failures };
}
