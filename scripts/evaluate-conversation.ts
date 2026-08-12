import { resolve } from "node:path";
import { arch, cpus, hostname, platform, release, totalmem } from "node:os";
import { completeTextWithOllama } from "../lib/providers/ollama.ts";
import type { ChatMessage } from "../lib/providers/types.ts";
import { selectRelevantMemoriesFrom } from "../lib/memories.ts";
import { answerDeterministicConversationRequest, buildConversationMessages, buildSemanticRepairMessages } from "../lib/conversation-orchestration.ts";
import { getConfiguredChatModel, getConfiguredContextTokens, getLocalOllamaBaseUrl } from "../lib/local-runtime-config.ts";
import { applySelectedMemoryToContract, chooseSemanticRepair, compileAnswerContract, enforceReasoningInvariants } from "../lib/conversation-contract.ts";
import {
  conversationEvaluationCases as cases,
  conversationEvaluationSuite as suite,
  getConversationEvaluationSuiteDigest,
  scoreConversationEvaluationAnswer as score,
  validateConversationEvaluationSuite,
} from "../lib/conversation-evaluation-suite.ts";
import type {
  ConversationEvaluationCase as Case,
  ConversationEvaluationResult as EvaluationResult,
} from "../lib/conversation-evaluation-suite.ts";
import { ensurePrivateDirectory, writePrivateJsonFileAtomic } from "../lib/private-storage.ts";
import { readConversationEvaluationGitCandidate } from "../lib/conversation-evaluation-runtime.ts";
import { assessConversationEvaluation } from "../lib/conversation-evaluation-assessment.ts";
import { acquireProfileMaintenanceBinding } from "../lib/profile-maintenance.ts";

function baselineMessages(testCase: Case): ChatMessage[] {
  const latest = [...testCase.messages].reverse().find((message) => message.role === "user")?.content ?? "";
  const selected = selectRelevantMemoriesFrom(testCase.memories ?? [], latest);
  return selected.length ? [{ role: "system", content: `RELEVANT USER-APPROVED LOCAL MEMORY:\n${selected.map((item) => `- [${item.kind}] ${item.content}`).join("\n")}\nUse only entries that help answer the current request. Never reveal unrelated memories.` }, ...testCase.messages] : testCase.messages;
}

const mode = process.argv.includes("--baseline") ? "baseline" : "candidate";
const requestedIds = process.argv.filter((argument) => argument.startsWith("--id=")).map((argument) => argument.slice(5));
const criticalOnly = process.argv.includes("--critical-only");
if (criticalOnly && requestedIds.length) throw new Error("Use either --critical-only or explicit --id values, not both.");
const selectedCases = criticalOnly ? cases.filter((testCase) => testCase.critical) : requestedIds.length ? cases.filter((testCase) => requestedIds.includes(testCase.id)) : cases;
if (requestedIds.length && selectedCases.length !== requestedIds.length) throw new Error("One or more requested conversation case IDs do not exist.");
const capabilityCounts = validateConversationEvaluationSuite();
if (process.argv.includes("--validate-only")) {
  console.log(`PASS: ${suite.name} ${suite.version} has 60 cases, 12 capabilities, and five cases per capability.`);
  process.exit(0);
}
const profileMaintenance = acquireProfileMaintenanceBinding({ label: "Conversation evaluation" });

async function localRuntimeMetadata() {
  const baseUrl = getLocalOllamaBaseUrl();
  const model = getConfiguredChatModel();
  const [versionResponse, showResponse, tagsResponse] = await Promise.all([
    fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(2_500) }),
    fetch(`${baseUrl}/api/show`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }), signal: AbortSignal.timeout(5_000) }),
    fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5_000) }),
  ]);
  if (!versionResponse.ok) throw new Error(`Ollama version metadata failed with HTTP ${versionResponse.status}.`);
  if (!showResponse.ok) throw new Error(`Ollama model metadata failed with HTTP ${showResponse.status}.`);
  if (!tagsResponse.ok) throw new Error(`Ollama model digest lookup failed with HTTP ${tagsResponse.status}.`);
  const version = (await versionResponse.json()) as { version?: unknown };
  const show = (await showResponse.json()) as { details?: unknown; model_info?: Record<string, unknown> };
  const tags = (await tagsResponse.json()) as { models?: Array<{ name?: unknown; model?: unknown; digest?: unknown }> };
  const installed = (tags.models ?? []).filter((candidate) => candidate.name === model || candidate.model === model);
  if (installed.length !== 1) throw new Error(`Ollama must report exactly one immutable digest for configured model ${model}.`);
  const digest = typeof installed[0]!.digest === "string" ? installed[0]!.digest.replace(/^sha256:/i, "").toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`Ollama did not report a valid SHA-256 digest for configured model ${model}.`);
  if (!show.details || typeof show.details !== "object" || Array.isArray(show.details)) throw new Error(`Ollama did not report model details for configured model ${model}.`);
  const details = show.details as Record<string, unknown>;
  if (typeof details.quantization_level !== "string" || !details.quantization_level.trim()) throw new Error(`Ollama did not report quantization details for configured model ${model}.`);
  const git = readConversationEvaluationGitCandidate();
  return {
    git,
    model: {
      name: model,
      configuredContext: String(getConfiguredContextTokens()),
      digest,
      details,
      contextLength: Object.entries(show.model_info ?? {}).find(([key]) => key.endsWith(".context_length"))?.[1] ?? null,
    },
    ollama: { version: typeof version.version === "string" ? version.version : null },
    host: { hostname: hostname(), platform: platform(), release: release(), architecture: arch(), cpu: cpus()[0]?.model ?? null, logicalCpuCount: cpus().length, totalMemoryBytes: totalmem(), node: process.version },
    runState: process.argv.includes("--cold") ? "cold-declared" : "warm-or-unspecified",
  };
}

const results: EvaluationResult[] = [];
const startedAt = new Date().toISOString();
const runtime = await localRuntimeMetadata();
console.log(`Running ${selectedCases.length} synthetic Mind & Memory cases (${mode}, suite ${suite.version}).`);
for (const [index, testCase] of selectedCases.entries()) {
  profileMaintenance.assertCurrent();
  const started = Date.now();
  try {
    const directBoundary = mode === "candidate" ? answerDeterministicConversationRequest(testCase.messages) : null;
    const built = mode === "baseline" ? null : buildConversationMessages(testCase.messages, testCase.memories);
    const messages = mode === "baseline" ? baselineMessages(testCase) : built!.messages;
    const contract = applySelectedMemoryToContract(compileAnswerContract(testCase.messages), built?.memories ?? []);
    let generated = directBoundary ?? await completeTextWithOllama(messages, { numPredict: 500, timeoutMs: 180_000 });
    const repairMessages = mode === "candidate" && !directBoundary ? buildSemanticRepairMessages(messages, generated, testCase.messages) : null;
    if (repairMessages) generated = chooseSemanticRepair(generated, await completeTextWithOllama(repairMessages, { numPredict: 500, timeoutMs: 180_000 }), contract);
    const answer = enforceReasoningInvariants(generated, contract);
    const evaluation = score(answer, testCase.rule);
    results.push({ id: testCase.id, category: testCase.category, critical: Boolean(testCase.critical), input: { messages: testCase.messages, memories: testCase.memories ?? [], rule: testCase.rule }, answer, latencyMs: Date.now() - started, ...evaluation });
    console.log(`${evaluation.passed ? "PASS" : "FAIL"} ${index + 1}/${selectedCases.length} ${testCase.id} (${Date.now() - started}ms)`);
    for (const check of evaluation.checks.filter((item) => !item.passed)) console.log(`  ${check.name}`);
  } catch (error) {
    results.push({ id: testCase.id, category: testCase.category, critical: Boolean(testCase.critical), input: { messages: testCase.messages, memories: testCase.memories ?? [], rule: testCase.rule }, answer: "", latencyMs: Date.now() - started, passed: false, error: error instanceof Error ? error.message : String(error) });
    console.log(`ERROR ${index + 1}/${selectedCases.length} ${testCase.id}: ${error instanceof Error ? error.message : error}`);
  }
}
const passed = results.filter((result) => result.passed).length;
const completed = results.filter((result) => !("error" in result));
const critical = results.filter((result) => result.critical);
const byCapability = Object.fromEntries([...capabilityCounts.keys()].map((capability) => {
  const capabilityResults = results.filter((result) => result.category === capability);
  const capabilityPassed = capabilityResults.filter((result) => result.passed).length;
  return [capability, { passed: capabilityPassed, total: capabilityResults.length, passRate: capabilityResults.length ? capabilityPassed / capabilityResults.length : null }];
}));
const summary = {
  suite: { ...suite, digest: getConversationEvaluationSuiteDigest() },
  mode,
  startedAt,
  completedAt: new Date().toISOString(),
  runtime,
  selection: { completeSuite: !criticalOnly && requestedIds.length === 0, criticalOnly, requestedIds },
  totals: { passed, total: selectedCases.length, passRate: passed / selectedCases.length, completed: completed.length, completionRate: completed.length / selectedCases.length, errors: selectedCases.length - completed.length },
  critical: { passed: critical.filter((result) => result.passed).length, total: critical.length, passRate: critical.length ? critical.filter((result) => result.passed).length / critical.length : null },
  byCapability,
  averageLatencyMs: completed.length ? Math.round(completed.reduce((sum, result) => sum + result.latencyMs, 0) / completed.length) : null,
  results,
};
const assessment = assessConversationEvaluation(summary);
const outputDirectory = profileMaintenance.dataPath("evaluations", "results");
ensurePrivateDirectory(outputDirectory);
const output = resolve(outputDirectory, `conversation-${mode}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
profileMaintenance.assertCurrent();
writePrivateJsonFileAtomic(output, { ...summary, assessment });
console.log(`\nPass rate: ${(summary.totals.passRate * 100).toFixed(1)}% (${passed}/${selectedCases.length})`);
console.log(`Critical trust pass rate: ${summary.critical.passRate === null ? "n/a" : `${(summary.critical.passRate * 100).toFixed(1)}% (${summary.critical.passed}/${summary.critical.total})`}`);
console.log(`Average latency: ${summary.averageLatencyMs === null ? "n/a" : `${(summary.averageLatencyMs / 1000).toFixed(1)}s`}`);
console.log(`Exit assessment: ${assessment.passed ? "PASS" : `FAIL (${assessment.failures.join(" ")})`}`);
console.log(`Private result: ${output}`);
if (!assessment.passed) process.exitCode = 1;
profileMaintenance.release();
