import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadKnowledgeEvaluationCases, scoreKnowledgeAnswer } from "../lib/knowledge-evaluation.ts";
import { countCitedSources, generateGroundedTeacherAnswer } from "../lib/knowledge-grounding.ts";
import { knowledgeRoot, searchKnowledge } from "../lib/knowledge.ts";
import { buildTeacherMessages } from "../lib/teacher-mode.ts";

const localEnvironmentPath = resolve(process.cwd(), ".env.local");
if (existsSync(localEnvironmentPath)) {
  for (const line of readFileSync(localEnvironmentPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}
const { completeTextWithOllama } = await import("../lib/providers/ollama.ts");

const option = (name: string) => process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
const fixturePath = resolve(option("file") ?? resolve(knowledgeRoot, "evaluations", "starter.json"));
if (!existsSync(fixturePath)) throw new Error(`Evaluation file not found: ${fixturePath}`);
const subject = option("subject");
const ids = new Set((option("ids") ?? "").split(",").filter(Boolean));
const limit = Number(option("limit") ?? 0);
const sample = Number(option("sample") ?? 0);
let cases = loadKnowledgeEvaluationCases(fixturePath).filter((item) => !subject || item.subject === subject);
if (ids.size) cases = cases.filter((item) => ids.has(item.id));
if (sample > 0 && sample < cases.length) {
  const subjects = [...new Set(cases.map((item) => item.subject))];
  const sampled = subjects.flatMap((name) => cases.filter((item) => item.subject === name).slice(0, 1));
  cases = [...sampled, ...cases.filter((item) => !sampled.includes(item))].slice(0, sample);
}
if (limit > 0) cases = cases.slice(0, limit);

console.log(`Running ${cases.length} end-to-end local answer evaluations. This intentionally waits for Teacher Mode generation and review.`);
type AnswerEvaluationResult = ReturnType<typeof scoreKnowledgeAnswer> & {
  id: string;
  subject: string;
  difficulty: string;
  query: string;
  revised: boolean;
  latencyMs: number;
  answer: string;
  grounding: Awaited<ReturnType<typeof generateGroundedTeacherAnswer>>["audit"];
};
const results: AnswerEvaluationResult[] = [];
for (const [index, item] of cases.entries()) {
  const started = performance.now();
  const sources = await searchKnowledge(item.query, 5);
  const grounded = await generateGroundedTeacherAnswer(buildTeacherMessages(item.query, [], sources), sources, completeTextWithOllama);
  const score = scoreKnowledgeAnswer(item, grounded.answer, countCitedSources(grounded.answer), grounded.audit.passed);
  const result = { id: item.id, subject: item.subject, difficulty: item.difficulty, query: item.query, ...score, revised: grounded.revised, latencyMs: Math.round(performance.now() - started), grounding: grounded.audit, answer: grounded.answer };
  results.push(result);
  console.log(`${score.passed ? "PASS" : "FAIL"} ${index + 1}/${cases.length} ${item.id} (${result.latencyMs}ms${grounded.revised ? ", revised" : ""})`);
  if (!score.passed) console.log(`  ${score.failures.join("; ")}`);
}

const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const groups = (field: "subject" | "difficulty") => Object.fromEntries([...new Set(results.map((result) => result[field]))].map((value) => {
  const group = results.filter((result) => result[field] === value);
  return [value, { cases: group.length, passRate: average(group.map((result) => Number(result.passed))), conceptCoverage: average(group.map((result) => result.conceptCoverage)) }];
}));
const summary = {
  cases: results.length,
  passed: results.filter((result) => result.passed).length,
  passRate: average(results.map((result) => Number(result.passed))),
  conceptCoverage: average(results.map((result) => result.conceptCoverage)),
  groundingPassRate: average(results.map((result) => Number(result.groundingPassed))),
  forbiddenClaimsFreeRate: average(results.map((result) => Number(result.forbiddenClaimsFree))),
  revisionRate: average(results.map((result) => Number(result.revised))),
  averageLatencyMs: average(results.map((result) => result.latencyMs)),
  bySubject: groups("subject"),
  byDifficulty: groups("difficulty"),
};
const outputRoot = resolve(knowledgeRoot, "evaluations", "results");
mkdirSync(outputRoot, { recursive: true });
const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
const outputPath = resolve(outputRoot, `answers-${stamp}.json`);
writeFileSync(outputPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), fixturePath, summary, results }, null, 2)}\n`);
console.log("\nEnd-to-end answer quality summary");
console.log(`Pass rate: ${(summary.passRate * 100).toFixed(1)}% (${summary.passed}/${summary.cases})`);
console.log(`Required-concept coverage: ${(summary.conceptCoverage * 100).toFixed(1)}%`);
console.log(`Grounding pass rate: ${(summary.groundingPassRate * 100).toFixed(1)}%`);
console.log(`Revision rate: ${(summary.revisionRate * 100).toFixed(1)}%`);
console.log(`Average latency: ${(summary.averageLatencyMs / 1000).toFixed(1)}s`);
console.log(`Private result: ${outputPath}`);
