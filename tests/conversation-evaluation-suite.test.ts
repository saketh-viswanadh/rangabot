import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationEvaluationCases,
  conversationEvaluationSuite,
  getConversationEvaluationCaseDigest,
  getConversationEvaluationSuiteDigest,
  validateConversationEvaluationSuite,
} from "../lib/conversation-evaluation-suite.ts";

const frozenSuiteDigest = "fe5dcaf10b74e3375b57102f938d11d4f3f4ae901f38d77a2d108def783321b0";

test("pins every frozen 1.0.12 prompt, memory, rule, and capability assignment", () => {
  assert.equal(conversationEvaluationSuite.version, "1.0.12");
  assert.equal(conversationEvaluationCases.length, 60);
  assert.equal(validateConversationEvaluationSuite().size, 12);
  assert.equal(getConversationEvaluationSuiteDigest(), frozenSuiteDigest);
  assert.equal(new Set(conversationEvaluationCases.map((testCase) => getConversationEvaluationCaseDigest(testCase.id))).size, 60);
});
