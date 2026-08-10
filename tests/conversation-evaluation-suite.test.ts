import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationEvaluationCases,
  conversationEvaluationSuite,
  getConversationEvaluationCaseDigest,
  getConversationEvaluationSuiteDigest,
  validateConversationEvaluationSuite,
} from "../lib/conversation-evaluation-suite.ts";

const frozenSuiteDigest = "363841c5c3f36e2d169c01ea72d6a7960ce97d8f2ef7c49b3af11f122ef76b14";

test("pins every frozen 1.0.13 prompt, memory, rule, metadata, and capability assignment", () => {
  assert.equal(conversationEvaluationSuite.version, "1.0.13");
  assert.equal(conversationEvaluationCases.length, 60);
  assert.equal(validateConversationEvaluationSuite().size, 12);
  assert.equal(getConversationEvaluationSuiteDigest(), frozenSuiteDigest);
  assert.equal(new Set(conversationEvaluationCases.map((testCase) => getConversationEvaluationCaseDigest(testCase.id))).size, 60);
  assert.deepEqual(conversationEvaluationCases.filter((testCase) => testCase.humanSemanticReviewRequired).map((testCase) => testCase.id), ["false-premise-01"]);
});
