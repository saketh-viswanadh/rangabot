import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadKnowledgeEvaluationCases, scoreKnowledgeRetrieval, summarizeKnowledgeEvaluation } from "../lib/knowledge-evaluation.ts";
import { knowledgeRoot, searchKnowledge } from "../lib/knowledge.ts";

const requestedPath = process.argv.find((argument) => argument.startsWith("--file="))?.slice("--file=".length);
const fixturePath = requestedPath ? resolve(requestedPath) : resolve(knowledgeRoot, "evaluations", "starter.json");
if (!existsSync(fixturePath)) throw new Error(`Evaluation file not found: ${fixturePath}`);

const cases = loadKnowledgeEvaluationCases(fixturePath);
const results = [];
console.log(`Running ${cases.length} local retrieval evaluations from ${fixturePath}`);
for (const [index, item] of cases.entries()) {
  const started = performance.now();
  const retrieved = await searchKnowledge(item.query, 5);
  const result = scoreKnowledgeRetrieval(item, retrieved, Math.round(performance.now() - started));
  results.push(result);
  console.log(`${result.passed ? "PASS" : "FAIL"} ${index + 1}/${cases.length} ${item.id} (${result.latencyMs}ms)`);
  if (!result.passed) console.log(`  ${result.failures.join("; ")} | returned: ${result.titles.join("; ") || "none"}`);
}

const summary = summarizeKnowledgeEvaluation(results);
const outputRoot = resolve(knowledgeRoot, "evaluations", "results");
mkdirSync(outputRoot, { recursive: true });
const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
const outputPath = resolve(outputRoot, `retrieval-${stamp}.json`);
writeFileSync(outputPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), fixturePath, summary, results }, null, 2)}\n`);

console.log("\nRetrieval quality summary");
console.log(`Pass rate: ${(summary.passRate * 100).toFixed(1)}% (${summary.passed}/${summary.cases})`);
console.log(`Expected-source coverage: ${(summary.expectedCoverage * 100).toFixed(1)}%`);
console.log(`Contamination-free: ${(summary.contaminationFreeRate * 100).toFixed(1)}%`);
console.log(`Passage locator coverage: ${(summary.locatorRate * 100).toFixed(1)}%`);
console.log(`Latency p50 / p95: ${summary.latencyP50Ms}ms / ${summary.latencyP95Ms}ms`);
console.log(`Private result: ${outputPath}`);
if (summary.passRate < .8) process.exitCode = 1;
