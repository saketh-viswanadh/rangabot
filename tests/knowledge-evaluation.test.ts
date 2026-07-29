import assert from "node:assert/strict";
import test from "node:test";
import { loadKnowledgeEvaluationCases, scoreKnowledgeAnswer, scoreKnowledgeRetrieval, summarizeKnowledgeEvaluation } from "../lib/knowledge-evaluation.ts";
import { resolve } from "node:path";
import { buildEvidencePlan } from "../lib/teacher-mode.ts";

const result = (title: string, path: string, score = 1) => ({ title, path, chunk: 1, content: "Evidence", score, sectionPath: "Chapter 1" });

test("scores expected sources, contamination, diversity, and locators", () => {
  const scored = scoreKnowledgeRetrieval({
    id: "clustering", subject: "machine-learning", difficulty: "advanced", query: "compare clustering", expectedTitlePatterns: ["scikit", "statistical learning"], requiredAnswerConcepts: [["cluster"]],
    minimumExpectedMatches: 2, minimumSources: 2, forbiddenTitlePatterns: ["python"],
  }, [result("Scikit-learn guide", "/ml-a"), result("Statistical Learning", "/ml-b")], 25);
  assert.equal(scored.passed, true);
  assert.equal(scored.expectedCoverage, 1);
  assert.equal(scored.contaminationFree, true);
  assert.equal(scored.sourceCount, 2);
  assert.equal(scored.locatorRate, 1);
});

test("fails visibly when retrieval admits an unrelated source", () => {
  const scored = scoreKnowledgeRetrieval({
    id: "myth", subject: "indian-mythology", difficulty: "beginner", query: "Ramayana", expectedTitlePatterns: ["ramayana"], forbiddenTitlePatterns: ["python"], requiredAnswerConcepts: [["Rama"]],
  }, [result("Fluent Python", "/python")], 50);
  assert.equal(scored.passed, false);
  assert.match(scored.failures.join(" "), /expected source coverage/);
  assert.match(scored.failures.join(" "), /forbidden source/);
  const summary = summarizeKnowledgeEvaluation([scored]);
  assert.equal(summary.passRate, 0);
  assert.equal(summary.contaminationFreeRate, 0);
});

test("scores end-to-end answer concepts, grounding, and source synthesis", () => {
  const item = {
    id: "cv", subject: "machine-learning", difficulty: "intermediate" as const, query: "cross validation",
    expectedTitlePatterns: ["book a", "book b"], minimumSources: 2,
    requiredAnswerConcepts: [["fold"], ["unseen|generaliz"], ["estimate|evaluate"]],
    forbiddenAnswerPatterns: ["guarantees perfect"],
  };
  const passed = scoreKnowledgeAnswer(item, "Repeated folds estimate performance on unseen data.", 2, true);
  assert.equal(passed.passed, true);
  assert.equal(passed.conceptCoverage, 1);
  const failed = scoreKnowledgeAnswer(item, "Cross-validation guarantees perfect accuracy.", 1, false);
  assert.equal(failed.passed, false);
  assert.match(failed.failures.join(" "), /grounding audit failed/);
  assert.match(failed.failures.join(" "), /forbidden answer claim/);
});

test("ships exactly 60 balanced, rubric-backed evaluation questions", () => {
  const cases = loadKnowledgeEvaluationCases(resolve(process.cwd(), "data", "knowledge", "evaluations", "starter.json"));
  assert.equal(cases.length, 60);
  assert.ok(new Set(cases.map((item) => item.subject)).size >= 10);
  assert.ok(cases.every((item) => item.requiredAnswerConcepts.length >= 3));
  assert.ok(cases.some((item) => item.minimumSources === 2));
});

test("builds an inspectable claim-to-source plan before Teacher Mode drafting", () => {
  const plan = buildEvidencePlan("Compare classification and regression", [{ ...result("Statistical Learning", "/ml"), content: "Classification predicts categories while regression predicts continuous values." }]);
  assert.match(plan, /REQUIRED ANSWER COVERAGE/);
  assert.match(plan, /CLAIM-TO-SOURCE PLAN/);
  assert.match(plan, /\[Source 1\] Statistical Learning/);
  assert.match(plan, /Compare classification and regression -> \[Source 1\]/i);
  assert.match(plan, /Do not collapse related concepts into synonyms/);
  assert.match(plan, /End every vault-grounded factual paragraph/);
});
