import {
  conversationHumanReviewAttestationStatement,
  conversationHumanReviewProtocol,
  createBlindReview,
  isHumanReviewerIdentityAllowed,
  type ConversationCapability,
  type ConversationEvaluationForReview,
} from "./conversation-human-review.ts";
import {
  conversationEvaluationCases,
  conversationEvaluationSuite,
  getConversationEvaluationSuiteDigest,
  scoreConversationEvaluationAnswer,
} from "./conversation-evaluation-suite.ts";
import { conversationEvaluationExitPolicy } from "./conversation-evaluation-assessment.ts";

export const conversationReleaseGatePolicy = {
  version: "1.3.0",
  suiteName: conversationEvaluationSuite.name,
  suiteSchemaVersion: conversationEvaluationSuite.schemaVersion,
  suiteVersion: conversationEvaluationSuite.version,
  fullCaseCount: conversationEvaluationExitPolicy.fullCaseCount,
  criticalCaseCount: conversationEvaluationExitPolicy.criticalCaseCount,
  criticalRunCount: 3,
  minimumFullPasses: conversationEvaluationExitPolicy.minimumFullPasses,
  casesPerCapability: conversationEvaluationExitPolicy.casesPerCapability,
  minimumCapabilityPasses: conversationEvaluationExitPolicy.minimumCapabilityPasses,
} as const;

const capabilities: readonly ConversationCapability[] = [
  "direct-usefulness",
  "format-adherence",
  "continuity",
  "correction-precedence",
  "honest-uncertainty",
  "reasoning",
  "adaptation",
  "memory-use",
  "memory-privacy",
  "memory-precedence",
  "unavailable-actions",
  "scope-judgment",
];

const capabilitySet = new Set<string>(capabilities);

export const frozenConversationCaseManifest: Readonly<Record<string, { category: ConversationCapability; critical: boolean }>> = Object.freeze(Object.fromEntries(
  conversationEvaluationCases.map((testCase) => [testCase.id, {
    category: testCase.category as ConversationCapability,
    critical: Boolean(testCase.critical),
  }]),
));

type GitCandidate = { commit: string; dirty: boolean };

type EvaluationResult = {
  id: string;
  category: ConversationCapability;
  critical: boolean;
  input: {
    messages: unknown;
    memories: unknown;
    rule: unknown;
  };
  answer: string;
  reportedPassed: boolean;
  rescoredPassed: boolean;
  hasError: boolean;
  latencyMs: number;
};

type EvaluationHost = {
  hostname: string;
  platform: string;
  release: string;
  architecture: string;
  cpu: string;
  logicalCpuCount: number;
  totalMemoryBytes: number;
  node: string;
  fingerprint: string;
};

type EvaluationSummary = {
  suite: { name: string; schemaVersion: number; version: string; digest: string };
  mode: string;
  startedAt: string;
  completedAt: string;
  runtime: {
    git: GitCandidate;
    model: {
      name: string;
      configuredContext: string;
      digest: string;
      details: Record<string, unknown>;
      detailsFingerprint: string;
      contextLength: number;
    };
    ollama: { version: string };
    host: EvaluationHost;
    runState: string;
  };
  selection: { completeSuite: boolean; criticalOnly: boolean; requestedIds: string[] };
  totals: { passed: number; total: number; passRate: number; completed: number; completionRate: number; errors: number };
  critical: { passed: number; total: number; passRate: number | null };
  byCapability: Record<ConversationCapability, { passed: number; total: number; passRate: number | null }>;
  averageLatencyMs: number;
  results: EvaluationResult[];
};

type HumanReviewResult = {
  schemaVersion: number;
  protocolVersion: string;
  packetId: string;
  auditedCommit: string;
  suiteVersion: string;
  reviewer: string;
  reviewedAt: string;
  attestation: {
    humanReviewer: boolean;
    completedWithoutAutomatedAssistance: boolean;
    ratingsFinalizedBeforeKey: boolean;
    statement: string;
  };
  meanRating: number;
  passed: boolean;
  gates: {
    mean: { passed: boolean; value: number; minimum: number };
    everyItem: { passed: boolean; failures: string[]; minimum: number };
    criticalItems: { passed: boolean; failures: string[]; minimum: number };
    humanSemanticItems: { passed: boolean; failures: string[]; minimum: number };
    materialTrust: { passed: boolean; failures: string[] };
  };
  items: Array<{
    itemId: string;
    critical: boolean;
    humanSemanticReviewRequired: boolean;
    rating: number;
    privacyFailure: boolean;
    fabricatedAction: boolean;
    materialTruthFailure: boolean;
  }>;
};

export type ConversationReleaseGateInput = {
  currentGit: GitCandidate;
  full: unknown;
  criticalRuns: unknown[];
  humanReview: unknown;
  criticalSourceIds: string[];
  sourceDigests: {
    full: string;
    critical: string[];
    human: string;
  };
};

export type ConversationReleaseGateDecision = {
  policyVersion: string;
  suiteVersion: string;
  passed: boolean;
  failures: string[];
  evidence: {
    commit: string;
    model: string | null;
    modelDigest: string | null;
    modelQuantization: string | null;
    contextTokens: number | null;
    full: { passed: number | null; total: number | null; criticalPassed: number | null; criticalTotal: number | null };
    repeatedCriticalRuns: number;
    humanMeanRating: number | null;
  };
};

class InvalidGateInputError extends Error {}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidGateInputError(`${path} must be an object.`);
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new InvalidGateInputError(`${path} must be an array.`);
  return value;
}

function asString(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new InvalidGateInputError(`${path} must be a non-empty string.`);
  return value;
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new InvalidGateInputError(`${path} must be a boolean.`);
  return value;
}

function asNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new InvalidGateInputError(`${path} must be a finite number.`);
  return value;
}

function asInteger(value: unknown, path: string): number {
  const number = asNumber(value, path);
  if (!Number.isSafeInteger(number)) throw new InvalidGateInputError(`${path} must be a safe integer.`);
  return number;
}

function asPositiveInteger(value: unknown, path: string): number {
  const number = asInteger(value, path);
  if (number <= 0) throw new InvalidGateInputError(`${path} must be a positive integer.`);
  return number;
}

function asNonNegativeInteger(value: unknown, path: string): number {
  const number = asInteger(value, path);
  if (number < 0) throw new InvalidGateInputError(`${path} must be a non-negative integer.`);
  return number;
}

function asNullableNumber(value: unknown, path: string): number | null {
  return value === null ? null : asNumber(value, path);
}

function asStringArray(value: unknown, path: string): string[] {
  return asArray(value, path).map((entry, index) => asString(entry, `${path}[${index}]`));
}

function asIsoDate(value: unknown, path: string): string {
  const date = asString(value, path);
  if (!Number.isFinite(Date.parse(date))) throw new InvalidGateInputError(`${path} must be a valid ISO-compatible date.`);
  return date;
}

function asCommit(value: unknown, path: string): string {
  const commit = asString(value, path);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commit)) throw new InvalidGateInputError(`${path} must be a 40- or 64-character Git commit.`);
  return commit.toLowerCase();
}

function asSha256(value: unknown, path: string): string {
  const digest = asString(value, path);
  if (!/^[0-9a-f]{64}$/i.test(digest)) throw new InvalidGateInputError(`${path} must be a SHA-256 digest.`);
  return digest.toLowerCase();
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function asContext(value: unknown, path: string): string {
  const context = asString(value, path);
  if (!/^[1-9]\d*$/.test(context)) throw new InvalidGateInputError(`${path} must declare a positive integer context size.`);
  return context;
}

function asOllamaVersion(value: unknown, path: string): string {
  const version = asString(value, path);
  if (!/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new InvalidGateInputError(`${path} must be a versioned Ollama runtime.`);
  }
  return version;
}

function parseHost(value: unknown, path: string): EvaluationHost {
  const host = asRecord(value, path);
  const parsed = {
    hostname: asString(host.hostname, `${path}.hostname`),
    platform: asString(host.platform, `${path}.platform`),
    release: asString(host.release, `${path}.release`),
    architecture: asString(host.architecture, `${path}.architecture`),
    cpu: asString(host.cpu, `${path}.cpu`),
    logicalCpuCount: asPositiveInteger(host.logicalCpuCount, `${path}.logicalCpuCount`),
    totalMemoryBytes: asPositiveInteger(host.totalMemoryBytes, `${path}.totalMemoryBytes`),
    node: asString(host.node, `${path}.node`),
  };
  if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(parsed.node)) {
    throw new InvalidGateInputError(`${path}.node must be a versioned Node.js runtime.`);
  }
  return { ...parsed, fingerprint: stableJson(parsed) };
}

function parseEvaluation(value: unknown, label: string): EvaluationSummary {
  const root = asRecord(value, label);
  const suite = asRecord(root.suite, `${label}.suite`);
  const runtime = asRecord(root.runtime, `${label}.runtime`);
  const git = asRecord(runtime.git, `${label}.runtime.git`);
  const model = asRecord(runtime.model, `${label}.runtime.model`);
  const ollama = asRecord(runtime.ollama, `${label}.runtime.ollama`);
  const selection = asRecord(root.selection, `${label}.selection`);
  const totals = asRecord(root.totals, `${label}.totals`);
  const critical = asRecord(root.critical, `${label}.critical`);
  const rawCapabilities = asRecord(root.byCapability, `${label}.byCapability`);
  const rawResults = asArray(root.results, `${label}.results`);
  const modelDetails = asRecord(model.details, `${label}.runtime.model.details`);
  asString(modelDetails.quantization_level, `${label}.runtime.model.details.quantization_level`);
  const byCapability = {} as EvaluationSummary["byCapability"];
  const capabilityKeys = Object.keys(rawCapabilities);
  if (capabilityKeys.length !== capabilities.length || capabilityKeys.some((key) => !capabilitySet.has(key))) {
    throw new InvalidGateInputError(`${label}.byCapability must contain exactly the twelve frozen capabilities.`);
  }
  for (const capability of capabilities) {
    const entry = asRecord(rawCapabilities[capability], `${label}.byCapability.${capability}`);
    byCapability[capability] = {
      passed: asInteger(entry.passed, `${label}.byCapability.${capability}.passed`),
      total: asInteger(entry.total, `${label}.byCapability.${capability}.total`),
      passRate: asNullableNumber(entry.passRate, `${label}.byCapability.${capability}.passRate`),
    };
  }
  const results = rawResults.map((entry, index): EvaluationResult => {
    const result = asRecord(entry, `${label}.results[${index}]`);
    const input = asRecord(result.input, `${label}.results[${index}].input`);
    const category = asString(result.category, `${label}.results[${index}].category`);
    if (!capabilitySet.has(category)) throw new InvalidGateInputError(`${label}.results[${index}].category is not a frozen capability.`);
    const id = asString(result.id, `${label}.results[${index}].id`);
    const answer = asString(result.answer, `${label}.results[${index}].answer`, true);
    const canonical = conversationEvaluationCases.find((testCase) => testCase.id === id);
    return {
      id,
      category: category as ConversationCapability,
      critical: asBoolean(result.critical, `${label}.results[${index}].critical`),
      input: {
        messages: asArray(input.messages, `${label}.results[${index}].input.messages`),
        memories: asArray(input.memories, `${label}.results[${index}].input.memories`),
        rule: asRecord(input.rule, `${label}.results[${index}].input.rule`),
      },
      answer,
      reportedPassed: asBoolean(result.passed, `${label}.results[${index}].passed`),
      rescoredPassed: canonical ? scoreConversationEvaluationAnswer(answer, canonical.rule).passed : false,
      hasError: Object.hasOwn(result, "error"),
      latencyMs: asNonNegativeInteger(result.latencyMs, `${label}.results[${index}].latencyMs`),
    };
  });
  return {
    suite: {
      name: asString(suite.name, `${label}.suite.name`),
      schemaVersion: asInteger(suite.schemaVersion, `${label}.suite.schemaVersion`),
      version: asString(suite.version, `${label}.suite.version`),
      digest: asSha256(suite.digest, `${label}.suite.digest`),
    },
    mode: asString(root.mode, `${label}.mode`),
    startedAt: asIsoDate(root.startedAt, `${label}.startedAt`),
    completedAt: asIsoDate(root.completedAt, `${label}.completedAt`),
    runtime: {
      git: {
        commit: asCommit(git.commit, `${label}.runtime.git.commit`),
        dirty: asBoolean(git.dirty, `${label}.runtime.git.dirty`),
      },
      model: {
        name: asString(model.name, `${label}.runtime.model.name`),
        configuredContext: asContext(model.configuredContext, `${label}.runtime.model.configuredContext`),
        digest: asSha256(model.digest, `${label}.runtime.model.digest`),
        details: modelDetails,
        detailsFingerprint: stableJson(modelDetails),
        contextLength: asPositiveInteger(model.contextLength, `${label}.runtime.model.contextLength`),
      },
      ollama: { version: asOllamaVersion(ollama.version, `${label}.runtime.ollama.version`) },
      host: parseHost(runtime.host, `${label}.runtime.host`),
      runState: asString(runtime.runState, `${label}.runtime.runState`),
    },
    selection: {
      completeSuite: asBoolean(selection.completeSuite, `${label}.selection.completeSuite`),
      criticalOnly: asBoolean(selection.criticalOnly, `${label}.selection.criticalOnly`),
      requestedIds: asStringArray(selection.requestedIds, `${label}.selection.requestedIds`),
    },
    totals: {
      passed: asInteger(totals.passed, `${label}.totals.passed`),
      total: asInteger(totals.total, `${label}.totals.total`),
      passRate: asNumber(totals.passRate, `${label}.totals.passRate`),
      completed: asInteger(totals.completed, `${label}.totals.completed`),
      completionRate: asNumber(totals.completionRate, `${label}.totals.completionRate`),
      errors: asInteger(totals.errors, `${label}.totals.errors`),
    },
    critical: {
      passed: asInteger(critical.passed, `${label}.critical.passed`),
      total: asInteger(critical.total, `${label}.critical.total`),
      passRate: asNullableNumber(critical.passRate, `${label}.critical.passRate`),
    },
    byCapability,
    averageLatencyMs: asNonNegativeInteger(root.averageLatencyMs, `${label}.averageLatencyMs`),
    results,
  };
}

function parseHumanReview(value: unknown): HumanReviewResult {
  const label = "human review";
  const root = asRecord(value, label);
  const gates = asRecord(root.gates, `${label}.gates`);
  const mean = asRecord(gates.mean, `${label}.gates.mean`);
  const everyItem = asRecord(gates.everyItem, `${label}.gates.everyItem`);
  const criticalItems = asRecord(gates.criticalItems, `${label}.gates.criticalItems`);
  const humanSemanticItems = asRecord(gates.humanSemanticItems, `${label}.gates.humanSemanticItems`);
  const materialTrust = asRecord(gates.materialTrust, `${label}.gates.materialTrust`);
  const attestation = asRecord(root.attestation, `${label}.attestation`);
  const items = asArray(root.items, `${label}.items`).map((entry, index) => {
    const item = asRecord(entry, `${label}.items[${index}]`);
    return {
      itemId: asString(item.itemId, `${label}.items[${index}].itemId`),
      critical: asBoolean(item.critical, `${label}.items[${index}].critical`),
      humanSemanticReviewRequired: asBoolean(item.humanSemanticReviewRequired, `${label}.items[${index}].humanSemanticReviewRequired`),
      rating: asInteger(item.rating, `${label}.items[${index}].rating`),
      privacyFailure: asBoolean(item.privacyFailure, `${label}.items[${index}].privacyFailure`),
      fabricatedAction: asBoolean(item.fabricatedAction, `${label}.items[${index}].fabricatedAction`),
      materialTruthFailure: asBoolean(item.materialTruthFailure, `${label}.items[${index}].materialTruthFailure`),
    };
  });
  return {
    schemaVersion: asInteger(root.schemaVersion, `${label}.schemaVersion`),
    protocolVersion: asString(root.protocolVersion, `${label}.protocolVersion`),
    packetId: asString(root.packetId, `${label}.packetId`),
    auditedCommit: asCommit(root.auditedCommit, `${label}.auditedCommit`),
    suiteVersion: asString(root.suiteVersion, `${label}.suiteVersion`),
    reviewer: asString(root.reviewer, `${label}.reviewer`),
    reviewedAt: asIsoDate(root.reviewedAt, `${label}.reviewedAt`),
    attestation: {
      humanReviewer: asBoolean(attestation.humanReviewer, `${label}.attestation.humanReviewer`),
      completedWithoutAutomatedAssistance: asBoolean(attestation.completedWithoutAutomatedAssistance, `${label}.attestation.completedWithoutAutomatedAssistance`),
      ratingsFinalizedBeforeKey: asBoolean(attestation.ratingsFinalizedBeforeKey, `${label}.attestation.ratingsFinalizedBeforeKey`),
      statement: asString(attestation.statement, `${label}.attestation.statement`),
    },
    meanRating: asNumber(root.meanRating, `${label}.meanRating`),
    passed: asBoolean(root.passed, `${label}.passed`),
    gates: {
      mean: {
        passed: asBoolean(mean.passed, `${label}.gates.mean.passed`),
        value: asNumber(mean.value, `${label}.gates.mean.value`),
        minimum: asNumber(mean.minimum, `${label}.gates.mean.minimum`),
      },
      everyItem: {
        passed: asBoolean(everyItem.passed, `${label}.gates.everyItem.passed`),
        failures: asStringArray(everyItem.failures, `${label}.gates.everyItem.failures`),
        minimum: asNumber(everyItem.minimum, `${label}.gates.everyItem.minimum`),
      },
      criticalItems: {
        passed: asBoolean(criticalItems.passed, `${label}.gates.criticalItems.passed`),
        failures: asStringArray(criticalItems.failures, `${label}.gates.criticalItems.failures`),
        minimum: asNumber(criticalItems.minimum, `${label}.gates.criticalItems.minimum`),
      },
      humanSemanticItems: {
        passed: asBoolean(humanSemanticItems.passed, `${label}.gates.humanSemanticItems.passed`),
        failures: asStringArray(humanSemanticItems.failures, `${label}.gates.humanSemanticItems.failures`),
        minimum: asNumber(humanSemanticItems.minimum, `${label}.gates.humanSemanticItems.minimum`),
      },
      materialTrust: {
        passed: asBoolean(materialTrust.passed, `${label}.gates.materialTrust.passed`),
        failures: asStringArray(materialTrust.failures, `${label}.gates.materialTrust.failures`),
      },
    },
    items,
  };
}

function sameNumber(left: number | null, right: number | null) {
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) < 1e-12;
}

function pushMismatch(failures: string[], condition: boolean, message: string) {
  if (!condition) failures.push(message);
}

function validateEvaluationIntegrity(summary: EvaluationSummary, label: string, currentCommit: string, failures: string[]) {
  const policy = conversationReleaseGatePolicy;
  pushMismatch(failures, summary.suite.name === policy.suiteName, `${label}: unexpected suite name.`);
  pushMismatch(failures, summary.suite.schemaVersion === policy.suiteSchemaVersion, `${label}: unexpected suite schema.`);
  pushMismatch(failures, summary.suite.version === policy.suiteVersion, `${label}: requires frozen suite ${policy.suiteVersion}.`);
  pushMismatch(failures, summary.suite.digest === getConversationEvaluationSuiteDigest(), `${label}: frozen suite fixture digest differs.`);
  pushMismatch(failures, summary.mode === "candidate", `${label}: baseline results cannot certify a release.`);
  pushMismatch(failures, summary.runtime.git.commit === currentCommit, `${label}: Git commit is not the current candidate.`);
  pushMismatch(failures, !summary.runtime.git.dirty, `${label}: evaluator recorded a dirty worktree.`);
  pushMismatch(failures, summary.runtime.runState === "cold-declared", `${label}: run was not declared cold.`);
  const elapsedMs = Date.parse(summary.completedAt) - Date.parse(summary.startedAt);
  pushMismatch(failures, elapsedMs > 0, `${label}: completion time must be later than start time.`);

  const ids = summary.results.map((result) => result.id);
  pushMismatch(failures, new Set(ids).size === ids.length, `${label}: case IDs are not unique.`);
  for (const result of summary.results) {
    const canonical = conversationEvaluationCases.find((testCase) => testCase.id === result.id);
    if (!canonical) {
      failures.push(`${label}: ${result.id} is not a frozen conversation case.`);
      continue;
    }
    const expectedInput = {
      messages: canonical.messages,
      memories: canonical.memories ?? [],
      rule: canonical.rule,
    };
    pushMismatch(
      failures,
      stableJson(result.input) === stableJson(expectedInput),
      `${label}: ${result.id} synthetic input or scoring rule differs from the frozen suite.`,
    );
    pushMismatch(
      failures,
      result.reportedPassed === result.rescoredPassed,
      `${label}: ${result.id} reported pass does not match independent frozen-rule scoring.`,
    );
  }
  const derivedPassed = summary.results.filter((result) => result.rescoredPassed).length;
  const derivedErrors = summary.results.filter((result) => result.hasError).length;
  const derivedCompleted = summary.results.length - derivedErrors;
  const derivedCritical = summary.results.filter((result) => result.critical);
  const derivedCriticalPassed = derivedCritical.filter((result) => result.rescoredPassed).length;
  const completedRows = summary.results.filter((result) => !result.hasError);
  const summedLatencyMs = summary.results.reduce((sum, result) => sum + result.latencyMs, 0);
  const derivedAverageLatencyMs = Math.round(completedRows.reduce((sum, result) => sum + result.latencyMs, 0) / completedRows.length);
  pushMismatch(failures, summary.totals.total === summary.results.length, `${label}: total does not match case rows.`);
  pushMismatch(failures, summary.totals.passed === derivedPassed, `${label}: passed total does not match case rows.`);
  pushMismatch(failures, summary.totals.errors === derivedErrors, `${label}: error total does not match case rows.`);
  pushMismatch(failures, summary.totals.completed === derivedCompleted, `${label}: completion total does not match case rows.`);
  pushMismatch(failures, sameNumber(summary.totals.passRate, derivedPassed / summary.results.length), `${label}: pass rate does not match case rows.`);
  pushMismatch(failures, sameNumber(summary.totals.completionRate, derivedCompleted / summary.results.length), `${label}: completion rate does not match case rows.`);
  pushMismatch(failures, summary.critical.total === derivedCritical.length, `${label}: critical total does not match case rows.`);
  pushMismatch(failures, summary.critical.passed === derivedCriticalPassed, `${label}: critical passes do not match case rows.`);
  pushMismatch(failures, sameNumber(summary.critical.passRate, derivedCritical.length ? derivedCriticalPassed / derivedCritical.length : null), `${label}: critical pass rate does not match case rows.`);
  pushMismatch(failures, summary.averageLatencyMs === derivedAverageLatencyMs, `${label}: average latency does not match completed case rows.`);
  pushMismatch(failures, elapsedMs >= summedLatencyMs, `${label}: wall-clock duration is shorter than summed per-row latency.`);

  for (const capability of capabilities) {
    const rows = summary.results.filter((result) => result.category === capability);
    const passed = rows.filter((result) => result.rescoredPassed).length;
    const recorded = summary.byCapability[capability];
    pushMismatch(failures, recorded.total === rows.length, `${label}: ${capability} total does not match case rows.`);
    pushMismatch(failures, recorded.passed === passed, `${label}: ${capability} passes do not match case rows.`);
    pushMismatch(failures, sameNumber(recorded.passRate, rows.length ? passed / rows.length : null), `${label}: ${capability} pass rate does not match case rows.`);
  }
}

function validateFull(summary: EvaluationSummary, failures: string[]) {
  const policy = conversationReleaseGatePolicy;
  pushMismatch(failures, summary.selection.completeSuite && !summary.selection.criticalOnly && summary.selection.requestedIds.length === 0, "full: selection is not the unfiltered complete suite.");
  pushMismatch(failures, summary.results.length === policy.fullCaseCount, `full: requires exactly ${policy.fullCaseCount} case rows.`);
  pushMismatch(failures, summary.totals.completed === policy.fullCaseCount && summary.totals.errors === 0, "full: every case must complete without an execution error.");
  pushMismatch(failures, summary.totals.passed >= policy.minimumFullPasses, `full: requires at least ${policy.minimumFullPasses}/${policy.fullCaseCount} passes.`);
  const criticalRows = summary.results.filter((result) => result.critical);
  pushMismatch(failures, criticalRows.length === policy.criticalCaseCount, `full: requires exactly ${policy.criticalCaseCount} critical cases.`);
  pushMismatch(failures, criticalRows.every((result) => result.rescoredPassed), "full: every critical case must pass independent frozen-rule scoring.");
  const manifestIds = Object.keys(frozenConversationCaseManifest).sort();
  const resultIds = summary.results.map((result) => result.id).sort();
  pushMismatch(failures, manifestIds.length === resultIds.length && manifestIds.every((id, index) => id === resultIds[index]), "full: case identities differ from the frozen suite manifest.");
  for (const result of summary.results) {
    const expected = frozenConversationCaseManifest[result.id];
    pushMismatch(failures, Boolean(expected) && expected.category === result.category && expected.critical === result.critical, `full: ${result.id} category or critical status differs from the frozen suite manifest.`);
  }
  for (const capability of capabilities) {
    const rows = summary.results.filter((result) => result.category === capability);
    const passed = rows.filter((result) => result.rescoredPassed).length;
    pushMismatch(failures, rows.length === policy.casesPerCapability, `full: ${capability} must contain exactly ${policy.casesPerCapability} cases.`);
    pushMismatch(failures, passed >= policy.minimumCapabilityPasses, `full: ${capability} requires at least ${policy.minimumCapabilityPasses}/${policy.casesPerCapability} passes.`);
  }
}

function validateCriticalRun(summary: EvaluationSummary, full: EvaluationSummary, index: number, failures: string[]) {
  const label = `critical run ${index + 1}`;
  const policy = conversationReleaseGatePolicy;
  pushMismatch(failures, !summary.selection.completeSuite && summary.selection.criticalOnly && summary.selection.requestedIds.length === 0, `${label}: selection is not the frozen critical-only suite.`);
  pushMismatch(failures, summary.results.length === policy.criticalCaseCount, `${label}: requires exactly ${policy.criticalCaseCount} case rows.`);
  pushMismatch(failures, summary.totals.completed === policy.criticalCaseCount && summary.totals.errors === 0, `${label}: every case must complete without an execution error.`);
  pushMismatch(failures, summary.totals.passed === policy.criticalCaseCount, `${label}: requires ${policy.criticalCaseCount}/${policy.criticalCaseCount} passes.`);
  pushMismatch(failures, summary.results.every((result) => result.critical && result.rescoredPassed), `${label}: contains a noncritical or independently failing case.`);
  const expectedIds = full.results.filter((result) => result.critical).map((result) => result.id).sort();
  const actualIds = summary.results.map((result) => result.id).sort();
  pushMismatch(failures, expectedIds.length === actualIds.length && expectedIds.every((id, position) => id === actualIds[position]), `${label}: case set differs from the full run's critical cases.`);
}

function validateHumanReview(
  review: HumanReviewResult,
  currentCommit: string,
  full: EvaluationSummary,
  criticalRuns: EvaluationSummary[],
  expectedReview: ReturnType<typeof createBlindReview>,
  failures: string[],
) {
  const protocol = conversationHumanReviewProtocol;
  pushMismatch(failures, review.schemaVersion === 3, "human review: unsupported result schema.");
  pushMismatch(failures, review.protocolVersion === protocol.version, "human review: protocol version does not match the frozen reviewer.");
  pushMismatch(failures, review.auditedCommit === currentCommit, "human review: audited commit is not the current candidate.");
  pushMismatch(failures, review.suiteVersion === conversationReleaseGatePolicy.suiteVersion, "human review: suite version does not match the frozen release suite.");
  pushMismatch(failures, review.packetId === expectedReview.packet.packetId, "human review: packet does not bind to the supplied full and three critical results' inputs, answers, and provenance.");
  const evidenceCompletedAt = Math.max(Date.parse(full.completedAt), ...criticalRuns.map((run) => Date.parse(run.completedAt)));
  pushMismatch(failures, Date.parse(review.reviewedAt) >= evidenceCompletedAt, "human review: review predates completion of the supplied evaluation evidence.");
  pushMismatch(failures, isHumanReviewerIdentityAllowed(review.reviewer), "human review: reviewer identity names an AI, model, bot, or automated agent rather than a human.");
  pushMismatch(
    failures,
    review.attestation.humanReviewer
      && review.attestation.completedWithoutAutomatedAssistance
      && review.attestation.ratingsFinalizedBeforeKey
      && review.attestation.statement === conversationHumanReviewAttestationStatement,
    "human review: exact human-only, no-automation, answer-key timing attestation is missing or false.",
  );
  pushMismatch(failures, review.passed, "human review: scorer did not pass the candidate.");
  const expectedItemCount = expectedReview.key.items.length;
  pushMismatch(failures, review.items.length === expectedItemCount, `human review: requires exactly ${expectedItemCount} rated items.`);
  const ids = review.items.map((item) => item.itemId);
  pushMismatch(failures, new Set(ids).size === ids.length, "human review: item IDs are not unique.");
  const expectedIds = Array.from({ length: expectedItemCount }, (_, index) => `R${String(index + 1).padStart(2, "0")}`);
  pushMismatch(failures, ids.length === expectedIds.length && ids.every((id, index) => id === expectedIds[index]), `human review: item IDs must be exactly R01 through R${String(expectedItemCount).padStart(2, "0")} in packet order.`);
  const expectedById = new Map(expectedReview.key.items.map((item) => [item.itemId, item]));
  pushMismatch(failures, review.items.every((item) => expectedById.get(item.itemId)?.critical === item.critical), "human review: item critical provenance differs from the recomputed blind packet.");
  pushMismatch(failures, review.items.every((item) => expectedById.get(item.itemId)?.humanSemanticReviewRequired === item.humanSemanticReviewRequired), "human review: semantic-review provenance differs from the recomputed blind packet.");
  const criticalItems = review.items.filter((item) => item.critical);
  const expectedCriticalItemCount = expectedReview.key.items.filter((item) => item.critical).length;
  pushMismatch(failures, criticalItems.length === expectedCriticalItemCount, `human review: exactly ${expectedCriticalItemCount} selected items must be critical.`);
  const semanticItems = review.items.filter((item) => item.humanSemanticReviewRequired);
  const expectedSemanticItems = expectedReview.key.items.filter((item) => item.humanSemanticReviewRequired);
  pushMismatch(failures, semanticItems.length === expectedSemanticItems.length && semanticItems.length === 4, "human review: all four full-and-repeated semantic outputs must be rated.");
  pushMismatch(failures, review.items.every((item) => item.rating >= 1 && item.rating <= 5), "human review: ratings must be integers from 1 to 5.");
  const actualMean = review.items.length ? review.items.reduce((sum, item) => sum + item.rating, 0) / review.items.length : 0;
  pushMismatch(failures, sameNumber(review.meanRating, actualMean), "human review: mean rating does not match item ratings.");
  pushMismatch(failures, review.meanRating >= protocol.minimumMeanRating, `human review: mean must be at least ${protocol.minimumMeanRating}/5.`);
  pushMismatch(failures, review.items.every((item) => item.rating >= protocol.minimumItemRating), `human review: every item must be at least ${protocol.minimumItemRating}/5.`);
  pushMismatch(failures, criticalItems.every((item) => item.rating >= protocol.minimumCriticalRating), `human review: every critical item must be at least ${protocol.minimumCriticalRating}/5.`);
  pushMismatch(failures, semanticItems.every((item) => item.rating >= protocol.minimumHumanSemanticRating), `human review: every human-required semantic item must be at least ${protocol.minimumHumanSemanticRating}/5.`);
  pushMismatch(failures, review.items.every((item) => !item.privacyFailure && !item.fabricatedAction && !item.materialTruthFailure), "human review: a material trust failure was recorded.");
  pushMismatch(failures, review.gates.mean.passed && review.gates.mean.minimum === protocol.minimumMeanRating && sameNumber(review.gates.mean.value, review.meanRating), "human review: mean gate is missing, failed, or inconsistent.");
  pushMismatch(failures, review.gates.everyItem.passed && review.gates.everyItem.minimum === protocol.minimumItemRating && review.gates.everyItem.failures.length === 0, "human review: per-item gate is missing, failed, or inconsistent.");
  pushMismatch(failures, review.gates.criticalItems.passed && review.gates.criticalItems.minimum === protocol.minimumCriticalRating && review.gates.criticalItems.failures.length === 0, "human review: critical-item gate is missing, failed, or inconsistent.");
  pushMismatch(failures, review.gates.humanSemanticItems.passed && review.gates.humanSemanticItems.minimum === protocol.minimumHumanSemanticRating && review.gates.humanSemanticItems.failures.length === 0, "human review: semantic-item gate is missing, failed, or inconsistent.");
  pushMismatch(failures, review.gates.materialTrust.passed && review.gates.materialTrust.failures.length === 0, "human review: material-trust gate is missing, failed, or inconsistent.");
}

export function evaluateConversationReleaseGate(input: ConversationReleaseGateInput): ConversationReleaseGateDecision {
  const failures: string[] = [];
  let full: EvaluationSummary | null = null;
  let criticalRuns: EvaluationSummary[] = [];
  let humanReview: HumanReviewResult | null = null;
  let expectedReview: ReturnType<typeof createBlindReview> | null = null;
  let currentCommit = "";
  try {
    asSha256(input.sourceDigests.full, "full source digest");
    asSha256(input.sourceDigests.human, "human-review source digest");
    const criticalDigests = input.sourceDigests.critical.map((digest, index) => asSha256(digest, `critical source digest ${index + 1}`));
    pushMismatch(failures, criticalDigests.length === conversationReleaseGatePolicy.criticalRunCount, "critical source digest list must contain exactly three SHA-256 digests.");
    pushMismatch(failures, new Set(criticalDigests).size === criticalDigests.length, "critical-only runs must contain three distinct source byte sequences.");
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  try {
    currentCommit = asCommit(input.currentGit.commit, "current Git commit");
    if (input.currentGit.dirty) failures.push("current Git worktree is dirty.");
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  try { full = parseEvaluation(input.full, "full"); }
  catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
  if (input.criticalRuns.length !== conversationReleaseGatePolicy.criticalRunCount) {
    failures.push(`release gate requires exactly ${conversationReleaseGatePolicy.criticalRunCount} critical-only runs.`);
  } else {
    criticalRuns = input.criticalRuns.flatMap((value, index) => {
      try { return [parseEvaluation(value, `critical run ${index + 1}`)]; }
      catch (error) { failures.push(error instanceof Error ? error.message : String(error)); return []; }
    });
  }
  if (input.criticalRuns.length === conversationReleaseGatePolicy.criticalRunCount) {
    try {
      expectedReview = createBlindReview(
        input.full as ConversationEvaluationForReview,
        input.criticalRuns as ConversationEvaluationForReview[],
        { full: input.sourceDigests.full, critical: input.sourceDigests.critical },
      );
    } catch (error) {
      failures.push(`human review: cannot recompute four-run blind packet: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try { humanReview = parseHumanReview(input.humanReview); }
  catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }

  const criticalSourceIds = Array.isArray(input.criticalSourceIds) ? input.criticalSourceIds : [];
  pushMismatch(failures, criticalSourceIds.length === conversationReleaseGatePolicy.criticalRunCount, "critical source list must contain exactly three paths.");
  pushMismatch(failures, new Set(criticalSourceIds).size === criticalSourceIds.length, "critical-only runs must come from three distinct private result files.");

  if (full && currentCommit) {
    validateEvaluationIntegrity(full, "full", currentCommit, failures);
    validateFull(full, failures);
  }
  if (full && currentCommit && criticalRuns.length === conversationReleaseGatePolicy.criticalRunCount) {
    for (const [index, run] of criticalRuns.entries()) {
      validateEvaluationIntegrity(run, `critical run ${index + 1}`, currentCommit, failures);
      validateCriticalRun(run, full, index, failures);
      pushMismatch(failures, run.runtime.model.name === full.runtime.model.name, `critical run ${index + 1}: model differs from the full run.`);
      pushMismatch(failures, run.runtime.model.configuredContext === full.runtime.model.configuredContext, `critical run ${index + 1}: context differs from the full run.`);
      pushMismatch(failures, run.runtime.model.digest === full.runtime.model.digest, `critical run ${index + 1}: immutable model digest differs from the full run.`);
      pushMismatch(failures, run.runtime.model.detailsFingerprint === full.runtime.model.detailsFingerprint, `critical run ${index + 1}: model quantization or details differ from the full run.`);
      pushMismatch(failures, run.runtime.model.contextLength === full.runtime.model.contextLength, `critical run ${index + 1}: model native context length differs from the full run.`);
      pushMismatch(failures, run.runtime.ollama.version === full.runtime.ollama.version, `critical run ${index + 1}: Ollama version differs from the full run.`);
      pushMismatch(failures, run.runtime.host.fingerprint === full.runtime.host.fingerprint, `critical run ${index + 1}: host hardware/runtime profile differs from the full run.`);
    }
    const runWindows = [full, ...criticalRuns].map((run) => `${run.startedAt}\0${run.completedAt}`);
    pushMismatch(failures, new Set(runWindows).size === runWindows.length, "full and repeated critical runs must have distinct run windows.");
  }
  if (humanReview && currentCommit && full && criticalRuns.length === conversationReleaseGatePolicy.criticalRunCount && expectedReview) {
    validateHumanReview(humanReview, currentCommit, full, criticalRuns, expectedReview, failures);
  }

  const uniqueFailures = [...new Set(failures)];
  return {
    policyVersion: conversationReleaseGatePolicy.version,
    suiteVersion: conversationReleaseGatePolicy.suiteVersion,
    passed: uniqueFailures.length === 0,
    failures: uniqueFailures,
    evidence: {
      commit: currentCommit,
      model: full?.runtime.model.name ?? null,
      modelDigest: full?.runtime.model.digest ?? null,
      modelQuantization: typeof full?.runtime.model.details.quantization_level === "string" ? full.runtime.model.details.quantization_level : null,
      contextTokens: full ? Number.parseInt(full.runtime.model.configuredContext, 10) : null,
      full: {
        passed: full?.totals.passed ?? null,
        total: full?.totals.total ?? null,
        criticalPassed: full?.critical.passed ?? null,
        criticalTotal: full?.critical.total ?? null,
      },
      repeatedCriticalRuns: criticalRuns.length,
      humanMeanRating: humanReview?.meanRating ?? null,
    },
  };
}
