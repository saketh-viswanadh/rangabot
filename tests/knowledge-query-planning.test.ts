import assert from "node:assert/strict";
import test from "node:test";
import { buildKnowledgeSearchQuery } from "../lib/knowledge-query-planning.ts";

test("adds the latest user topic to a context-dependent follow-up", () => {
  const query = buildKnowledgeSearchQuery("What about its limitations?", [
    { role: "user", content: "Explain random forests and how they combine decision trees." },
    { role: "assistant", content: "A random forest aggregates many trees." },
  ]);
  assert.equal(query, "Explain random forests and how they combine decision trees.\nWhat about its limitations?");
});

test("does not pollute a self-contained retrieval question with old history", () => {
  const query = buildKnowledgeSearchQuery("Compare L1 and L2 regularization", [
    { role: "user", content: "Tell me about Greek mythology." },
  ]);
  assert.equal(query, "Compare L1 and L2 regularization");
});

test("keeps a follow-up unchanged when no useful user context exists", () => {
  assert.equal(buildKnowledgeSearchQuery("How does it work?", [
    { role: "assistant", content: "What topic would you like to explore?" },
  ]), "How does it work?");
});
