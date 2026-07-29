import { readFileSync } from "node:fs";
import type { KnowledgeResult } from "./knowledge.ts";

export type KnowledgeEvaluationCase = {
  id: string;
  subject: string;
  difficulty: "beginner" | "intermediate" | "advanced";
  query: string;
  expectedTitlePatterns: string[];
  forbiddenTitlePatterns?: string[];
  minimumExpectedMatches?: number;
  minimumSources?: number;
  requiredAnswerConcepts: string[][];
  forbiddenAnswerPatterns?: string[];
};

export type KnowledgeEvaluationResult = {
  id: string;
  subject: string;
  difficulty: KnowledgeEvaluationCase["difficulty"];
  query: string;
  passed: boolean;
  expectedCoverage: number;
  contaminationFree: boolean;
  sourceCount: number;
  locatorRate: number;
  latencyMs: number;
  titles: string[];
  failures: string[];
};

function matches(title: string, pattern: string) {
  try {
    return new RegExp(pattern, "i").test(title);
  } catch {
    return title.toLowerCase().includes(pattern.toLowerCase());
  }
}

export function loadKnowledgeEvaluationCases(path: string) {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { cases?: KnowledgeEvaluationCase[] };
  if (!Array.isArray(parsed.cases) || !parsed.cases.length) throw new Error(`No evaluation cases found in ${path}`);
  for (const item of parsed.cases) {
    if (!item.id || !item.subject || !item.difficulty || !item.query || !item.expectedTitlePatterns?.length || !item.requiredAnswerConcepts?.length) throw new Error(`Invalid evaluation case in ${path}`);
  }
  return parsed.cases;
}

export function scoreKnowledgeAnswer(item: KnowledgeEvaluationCase, answer: string, citedSources: number, groundingPassed: boolean) {
  const covered = item.requiredAnswerConcepts.filter((alternatives) => alternatives.some((pattern) => matches(answer, pattern)));
  const forbidden = (item.forbiddenAnswerPatterns ?? []).filter((pattern) => matches(answer, pattern));
  const conceptCoverage = covered.length / item.requiredAnswerConcepts.length;
  const minimumCitedSources = Math.min(item.minimumSources ?? 1, item.expectedTitlePatterns.length);
  const failures: string[] = [];
  if (conceptCoverage < 2 / 3) failures.push(`answer concept coverage ${covered.length}/${item.requiredAnswerConcepts.length}`);
  if (forbidden.length) failures.push(`forbidden answer claim: ${forbidden.join(", ")}`);
  if (!groundingPassed) failures.push("grounding audit failed");
  if (citedSources < minimumCitedSources) failures.push(`cited source synthesis ${citedSources}/${minimumCitedSources}`);
  return { passed: failures.length === 0, conceptCoverage, forbiddenClaimsFree: forbidden.length === 0, citedSources, groundingPassed, failures };
}

export function scoreKnowledgeRetrieval(item: KnowledgeEvaluationCase, results: KnowledgeResult[], latencyMs: number): KnowledgeEvaluationResult {
  const titles = [...new Set(results.map((result) => result.title))];
  const matchedExpected = item.expectedTitlePatterns.filter((pattern) => titles.some((title) => matches(title, pattern)));
  const requiredExpected = Math.min(item.minimumExpectedMatches ?? 1, item.expectedTitlePatterns.length);
  const contaminating = (item.forbiddenTitlePatterns ?? []).filter((pattern) => titles.some((title) => matches(title, pattern)));
  const sourceCount = new Set(results.map((result) => result.path)).size;
  const minimumSources = item.minimumSources ?? 1;
  const located = results.filter((result) => Boolean(result.sectionPath || result.pageStart)).length;
  const failures: string[] = [];
  if (!results.length) failures.push("no results");
  if (matchedExpected.length < requiredExpected) failures.push(`expected source coverage ${matchedExpected.length}/${requiredExpected}`);
  if (contaminating.length) failures.push(`forbidden source match: ${contaminating.join(", ")}`);
  if (sourceCount < minimumSources) failures.push(`source diversity ${sourceCount}/${minimumSources}`);
  return {
    id: item.id,
    subject: item.subject,
    difficulty: item.difficulty,
    query: item.query,
    passed: failures.length === 0,
    expectedCoverage: matchedExpected.length / item.expectedTitlePatterns.length,
    contaminationFree: contaminating.length === 0,
    sourceCount,
    locatorRate: results.length ? located / results.length : 0,
    latencyMs,
    titles,
    failures,
  };
}

export function summarizeKnowledgeEvaluation(results: KnowledgeEvaluationResult[]) {
  const sortedLatency = results.map((result) => result.latencyMs).sort((left, right) => left - right);
  const percentile = (fraction: number) => sortedLatency[Math.min(sortedLatency.length - 1, Math.floor(sortedLatency.length * fraction))] ?? 0;
  const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const groups = (field: "subject" | "difficulty") => Object.fromEntries([...new Set(results.map((result) => result[field]))].map((value) => {
    const group = results.filter((result) => result[field] === value);
    return [value, { cases: group.length, passRate: average(group.map((result) => Number(result.passed))), expectedCoverage: average(group.map((result) => result.expectedCoverage)), contaminationFreeRate: average(group.map((result) => Number(result.contaminationFree))) }];
  }));
  return {
    cases: results.length,
    passed: results.filter((result) => result.passed).length,
    passRate: average(results.map((result) => Number(result.passed))),
    expectedCoverage: average(results.map((result) => result.expectedCoverage)),
    contaminationFreeRate: average(results.map((result) => Number(result.contaminationFree))),
    locatorRate: average(results.map((result) => result.locatorRate)),
    latencyP50Ms: percentile(.5),
    latencyP95Ms: percentile(.95),
    bySubject: groups("subject"),
    byDifficulty: groups("difficulty"),
  };
}
