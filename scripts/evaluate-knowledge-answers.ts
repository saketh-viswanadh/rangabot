import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { loadKnowledgeEvaluationCases, scoreKnowledgeAnswer } from "../lib/knowledge-evaluation.ts";
import { countCitedSources, generateGroundedTeacherAnswer } from "../lib/knowledge-grounding.ts";
import { knowledgeEvaluationFixtures, knowledgeEvaluationResults, searchKnowledge } from "../lib/knowledge.ts";
import { runtimePaths } from "../lib/runtime-paths.ts";
import { buildTeacherMessages } from "../lib/teacher-mode.ts";
import { ensurePrivateDirectory, writePrivateJsonFileAtomic } from "../lib/private-storage.ts";

const option = (name: string) => process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
const localEnvironmentPath = resolve(runtimePaths.resourceRoot, ".env.local");
if (existsSync(localEnvironmentPath)) {
  for (const line of readFileSync(localEnvironmentPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}
if (option("model")) process.env.OLLAMA_MODEL = option("model");
if (option("num-ctx")) process.env.OLLAMA_NUM_CTX = option("num-ctx");
const { completeTextWithOllama } = await import("../lib/providers/ollama.ts");
const { getConfiguredChatModel, getConfiguredContextTokens } = await import("../lib/local-runtime-config.ts");

const fixturePath = resolve(option("file") ?? resolve(knowledgeEvaluationFixtures, "starter.json"));
if (!existsSync(fixturePath)) throw new Error(`Evaluation file not found: ${fixturePath}`);
const subject = option("subject");
const ids = new Set((option("ids") ?? "").split(",").filter(Boolean));
const limit = Number(option("limit") ?? 0);
const sample = Number(option("sample") ?? 0);
const timeoutMs = Number(option("timeout-ms") ?? 300_000);
const evaluationModel = getConfiguredChatModel();
const evaluationContextTokens = getConfiguredContextTokens();
let cases = loadKnowledgeEvaluationCases(fixturePath).filter((item) => !subject || item.subject === subject);
if (ids.size) cases = cases.filter((item) => ids.has(item.id));
if (sample > 0 && sample < cases.length) {
  const subjects = [...new Set(cases.map((item) => item.subject))];
  const sampled = subjects.flatMap((name) => cases.filter((item) => item.subject === name).slice(0, 1));
  cases = [...sampled, ...cases.filter((item) => !sampled.includes(item))].slice(0, sample);
}
if (limit > 0) cases = cases.slice(0, limit);

console.log(`Running ${cases.length} end-to-end local answer evaluations. This intentionally waits for Teacher Mode generation and review.`);
console.log(`Model: ${evaluationModel} · context: ${evaluationContextTokens} tokens.`);
console.log(`Per-generation timeout: ${Math.round(timeoutMs / 1000)}s. Completed cases are checkpointed locally after every answer.`);
type AnswerEvaluationResult = ReturnType<typeof scoreKnowledgeAnswer> & {
  id: string;
  subject: string;
  difficulty: string;
  query: string;
  revised: boolean;
  separated: boolean;
  latencyMs: number;
  answer: string;
  grounding: Awaited<ReturnType<typeof generateGroundedTeacherAnswer>>["audit"] | null;
  error?: string;
};
const outputRoot = knowledgeEvaluationResults;
ensurePrivateDirectory(outputRoot);
const runKey = createHash("sha256").update(JSON.stringify({ fixturePath, ids: cases.map((item) => item.id), model: evaluationModel, contextTokens: evaluationContextTokens })).digest("hex").slice(0, 12);
const checkpointPath = resolve(outputRoot, `answers-checkpoint-${runKey}.json`);
const saved = existsSync(checkpointPath) ? JSON.parse(readFileSync(checkpointPath, "utf8")) as { results?: AnswerEvaluationResult[] } : {};
const completedResults: AnswerEvaluationResult[] = saved.results ?? [];
const completedIds = new Set(completedResults.map((result) => result.id));
if (completedResults.length) console.log(`Resuming from checkpoint: ${completedResults.length}/${cases.length} completed.`);
const errorResults: AnswerEvaluationResult[] = [];
const saveCheckpoint = () => {
  writePrivateJsonFileAtomic(checkpointPath, { fixturePath, model: evaluationModel, contextTokens: evaluationContextTokens, results: completedResults });
};
for (const [index, item] of cases.entries()) {
  if (completedIds.has(item.id)) {
    console.log(`SKIP ${index + 1}/${cases.length} ${item.id} (checkpointed)`);
    continue;
  }
  const started = performance.now();
  try {
    const sources = await searchKnowledge(item.query, 5);
    const grounded = await generateGroundedTeacherAnswer(buildTeacherMessages(item.query, [], sources), sources, (messages) => completeTextWithOllama(messages, { timeoutMs }));
    const score = scoreKnowledgeAnswer(item, grounded.answer, countCitedSources(grounded.answer), grounded.audit.passed);
    const result = { id: item.id, subject: item.subject, difficulty: item.difficulty, query: item.query, ...score, revised: grounded.revised, separated: grounded.separated, latencyMs: Math.round(performance.now() - started), grounding: grounded.audit, answer: grounded.answer };
    completedResults.push(result);
    completedIds.add(item.id);
    saveCheckpoint();
    console.log(`${score.passed ? "PASS" : "FAIL"} ${index + 1}/${cases.length} ${item.id} (${result.latencyMs}ms${grounded.revised ? ", revised" : ""})`);
    if (!score.passed) console.log(`  ${score.failures.join("; ")}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errorResults.push({ id: item.id, subject: item.subject, difficulty: item.difficulty, query: item.query, passed: false, conceptCoverage: 0, forbiddenClaimsFree: true, citedSources: 0, groundingPassed: false, failures: [`evaluation error: ${message}`], revised: false, separated: false, latencyMs: Math.round(performance.now() - started), grounding: null, answer: "", error: message });
    console.log(`ERROR ${index + 1}/${cases.length} ${item.id}: ${message}`);
    console.log("  Continuing; rerun the same command later to retry this case from the checkpoint.");
  }
}

const resultById = new Map([...completedResults, ...errorResults].map((result) => [result.id, result]));
const results = cases.flatMap((item) => resultById.get(item.id) ?? []);
const scoredResults = results.filter((result) => !result.error);

const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const groups = (field: "subject" | "difficulty") => Object.fromEntries([...new Set(scoredResults.map((result) => result[field]))].map((value) => {
  const group = scoredResults.filter((result) => result[field] === value);
  return [value, { cases: group.length, passRate: average(group.map((result) => Number(result.passed))), conceptCoverage: average(group.map((result) => result.conceptCoverage)) }];
}));
const summary = {
  cases: results.length,
  completedCases: scoredResults.length,
  executionErrors: errorResults.length,
  passed: scoredResults.filter((result) => result.passed).length,
  passRate: average(scoredResults.map((result) => Number(result.passed))),
  overallPassFloor: cases.length ? scoredResults.filter((result) => result.passed).length / cases.length : 0,
  conceptCoverage: average(scoredResults.map((result) => result.conceptCoverage)),
  groundingPassRate: average(scoredResults.map((result) => Number(result.groundingPassed))),
  forbiddenClaimsFreeRate: average(scoredResults.map((result) => Number(result.forbiddenClaimsFree))),
  revisionRate: average(scoredResults.map((result) => Number(result.revised))),
  separationRate: average(scoredResults.map((result) => Number(result.separated))),
  averageLatencyMs: average(scoredResults.map((result) => result.latencyMs)),
  bySubject: groups("subject"),
  byDifficulty: groups("difficulty"),
};
const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
const modelSlug = evaluationModel.replaceAll(/[^a-zA-Z0-9]+/g, "-").replaceAll(/^-|-$/g, "").toLowerCase();
const outputPath = resolve(outputRoot, `answers-${modelSlug}-${stamp}.json`);
writePrivateJsonFileAtomic(outputPath, { generatedAt: new Date().toISOString(), fixturePath, runtime: { model: evaluationModel, contextTokens: evaluationContextTokens }, summary, results });
console.log("\nEnd-to-end answer quality summary");
console.log(`Completed-case pass rate: ${(summary.passRate * 100).toFixed(1)}% (${summary.passed}/${summary.completedCases})`);
if (summary.executionErrors) console.log(`Provisional overall pass floor: ${(summary.overallPassFloor * 100).toFixed(1)}% (${summary.passed}/${summary.cases}; ${summary.executionErrors} execution errors excluded from quality averages)`);
console.log(`Required-concept coverage: ${(summary.conceptCoverage * 100).toFixed(1)}%`);
console.log(`Grounding pass rate: ${(summary.groundingPassRate * 100).toFixed(1)}%`);
console.log(`Revision rate: ${(summary.revisionRate * 100).toFixed(1)}%`);
console.log(`Evidence/background separation fallback: ${(summary.separationRate * 100).toFixed(1)}%`);
console.log(`Average latency: ${(summary.averageLatencyMs / 1000).toFixed(1)}s`);
console.log(`Private result: ${outputPath}`);
if (errorResults.length) {
  console.log(`${errorResults.length} case(s) ended with an execution error. Rerun the same command to resume and retry only unfinished cases.`);
  process.exitCode = 1;
} else if (existsSync(checkpointPath)) unlinkSync(checkpointPath);
