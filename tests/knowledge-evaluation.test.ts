import assert from "node:assert/strict";
import test from "node:test";
import { scoreKnowledgeRetrieval, summarizeKnowledgeEvaluation } from "../lib/knowledge-evaluation.ts";

const result = (title: string, path: string, score = 1) => ({ title, path, chunk: 1, content: "Evidence", score, sectionPath: "Chapter 1" });

test("scores expected sources, contamination, diversity, and locators", () => {
  const scored = scoreKnowledgeRetrieval({
    id: "clustering", query: "compare clustering", expectedTitlePatterns: ["scikit", "statistical learning"],
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
    id: "myth", query: "Ramayana", expectedTitlePatterns: ["ramayana"], forbiddenTitlePatterns: ["python"],
  }, [result("Fluent Python", "/python")], 50);
  assert.equal(scored.passed, false);
  assert.match(scored.failures.join(" "), /expected source coverage/);
  assert.match(scored.failures.join(" "), /forbidden source/);
  const summary = summarizeKnowledgeEvaluation([scored]);
  assert.equal(summary.passRate, 0);
  assert.equal(summary.contaminationFreeRate, 0);
});
