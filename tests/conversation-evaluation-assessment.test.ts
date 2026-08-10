import assert from "node:assert/strict";
import test from "node:test";
import {
  assessConversationEvaluation,
  type ConversationEvaluationAssessmentInput,
} from "../lib/conversation-evaluation-assessment.ts";
import { conversationEvaluationCapabilityOrder, conversationEvaluationSuite } from "../lib/conversation-evaluation-suite.ts";

function fullInput(): ConversationEvaluationAssessmentInput {
  return {
    suite: { version: conversationEvaluationSuite.version },
    selection: { completeSuite: true, criticalOnly: false, requestedIds: [] },
    totals: { passed: 60, total: 60, completed: 60, errors: 0 },
    critical: { passed: 22, total: 22 },
    byCapability: Object.fromEntries(
      conversationEvaluationCapabilityOrder.map((capability) => [capability, { passed: 5, total: 5 }]),
    ),
  };
}

test("a release-qualifying 59/60 full evaluation exits successfully", () => {
  const input = fullInput();
  input.totals.passed = 59;
  input.byCapability["direct-usefulness"] = { passed: 4, total: 5 };

  assert.deepEqual(assessConversationEvaluation(input), {
    scope: "full",
    passed: true,
    failures: [],
  });
});

test("full assessment enforces overall, critical, category, and completion gates independently", () => {
  const belowOverall = fullInput();
  belowOverall.totals.passed = 53;
  assert.match(assessConversationEvaluation(belowOverall).failures.join("\n"), /at least 54\/60/);

  const failedCritical = fullInput();
  failedCritical.totals.passed = 59;
  failedCritical.critical.passed = 21;
  failedCritical.byCapability["unavailable-actions"] = { passed: 4, total: 5 };
  assert.match(assessConversationEvaluation(failedCritical).failures.join("\n"), /all 22 critical/);

  const weakCapability = fullInput();
  weakCapability.totals.passed = 58;
  weakCapability.byCapability.reasoning = { passed: 3, total: 5 };
  assert.match(assessConversationEvaluation(weakCapability).failures.join("\n"), /reasoning must pass at least 4\/5/);

  const executionError = fullInput();
  executionError.totals.passed = 59;
  executionError.totals.completed = 59;
  executionError.totals.errors = 1;
  executionError.byCapability["direct-usefulness"] = { passed: 4, total: 5 };
  assert.match(assessConversationEvaluation(executionError).failures.join("\n"), /complete without an execution error/);
});

test("critical-only assessment requires an exact error-free 22/22", () => {
  const input = fullInput();
  input.selection = { completeSuite: false, criticalOnly: true, requestedIds: [] };
  input.totals = { passed: 22, total: 22, completed: 22, errors: 0 };

  assert.equal(assessConversationEvaluation(input).passed, true);

  input.totals.passed = 21;
  input.critical.passed = 21;
  assert.equal(assessConversationEvaluation(input).passed, false);
});

test("explicit selections remain strict all-pass diagnostics", () => {
  const input = fullInput();
  input.selection = { completeSuite: false, criticalOnly: false, requestedIds: ["direct-01", "format-01"] };
  input.totals = { passed: 2, total: 2, completed: 2, errors: 0 };
  input.critical = { passed: 0, total: 0 };

  assert.equal(assessConversationEvaluation(input).passed, true);

  input.totals.passed = 1;
  assert.match(assessConversationEvaluation(input).failures.join("\n"), /Every explicitly selected case must pass/);
});

test("ambiguous, duplicate, stale-suite, and internally inconsistent evidence fails closed", () => {
  const ambiguous = fullInput();
  ambiguous.selection = { completeSuite: true, criticalOnly: true, requestedIds: [] };
  assert.equal(assessConversationEvaluation(ambiguous).scope, "invalid");
  assert.equal(assessConversationEvaluation(ambiguous).passed, false);

  const duplicate = fullInput();
  duplicate.selection = { completeSuite: false, criticalOnly: false, requestedIds: ["direct-01", "direct-01"] };
  duplicate.totals = { passed: 2, total: 2, completed: 2, errors: 0 };
  assert.match(assessConversationEvaluation(duplicate).failures.join("\n"), /must be unique/);

  const stale = fullInput();
  stale.suite.version = "1.0.11";
  assert.match(assessConversationEvaluation(stale).failures.join("\n"), /frozen version 1\.0\.13/);

  const inconsistent = fullInput();
  inconsistent.totals.completed = 59;
  inconsistent.totals.errors = 0;
  assert.match(assessConversationEvaluation(inconsistent).failures.join("\n"), /Error count must equal/);
});
