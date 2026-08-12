import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  RESPONSE_FEEDBACK_CONFIRMATIONS,
  expectedResponseFeedbackOutcome,
  nextResponseFeedbackRating,
} from "../lib/response-feedback-contract.ts";
import { mergeResponseFeedbackRead, responseFeedbackBindingMatches } from "../lib/response-feedback-client-state.ts";
import { buildResponseFeedbackDailyEnvelope } from "../lib/response-feedback-export.ts";

test("selection state is exclusive, changeable, and selected activation clears", () => {
  assert.equal(nextResponseFeedbackRating(null, "helpful"), "helpful");
  assert.equal(nextResponseFeedbackRating("helpful", "needs-improvement"), "needs-improvement");
  assert.equal(nextResponseFeedbackRating("needs-improvement", "needs-improvement"), null);
  assert.equal(expectedResponseFeedbackOutcome(null, "helpful"), "saved");
  assert.equal(expectedResponseFeedbackOutcome("helpful", "needs-improvement"), "changed");
  assert.equal(expectedResponseFeedbackOutcome("helpful", null), "cleared");
  assert.deepEqual(RESPONSE_FEEDBACK_CONFIRMATIONS, {
    saved: "Feedback saved locally",
    changed: "Feedback changed locally",
    cleared: "Feedback cleared",
    failure: "Couldn’t save feedback on this device. Try again.",
  });
});

test("authoritative reads merge per-turn mutations and stale component generations cannot write", () => {
  const mutations = new Map([["older-turn", 3]]);
  assert.deepEqual(mergeResponseFeedbackRead(
    { "older-turn": null, "new-turn": null },
    { "older-turn": "helpful" },
    mutations,
    2,
  ), { "older-turn": "helpful", "new-turn": null });
  assert.equal(responseFeedbackBindingMatches("conversation-a", 3, "conversation-a", 3), true);
  assert.equal(responseFeedbackBindingMatches("conversation-a", 5, "conversation-a", 3), false);
  assert.equal(responseFeedbackBindingMatches("conversation-b", 3, "conversation-a", 3), false);
});

test("daily exchange is byte-for-field aligned and arithmetic-bound", () => {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const envelope = buildResponseFeedbackDailyEnvelope({
    build: "0.1.0+rfp.abcdef123456",
    buildDigest: "a".repeat(64),
    sourceVersion: "0.1.0",
    day: yesterday,
    counts: { eligibleResponses: 4, helpful: 2, needsImprovement: 1, rated: 3, unrated: 1 },
  });
  assert.deepEqual(Object.keys(envelope), ["type", "data"]);
  assert.equal(envelope.type, "response_feedback_daily");
  assert.deepEqual(Object.keys(envelope.data), [
    "schemaVersion", "repository", "build", "buildDigest", "sourceVersion", "dirty", "day",
    "windowStart", "windowEnd", "eligibleResponses", "helpful", "needsImprovement", "rated",
    "unrated", "generatedAt", "sourceStatus", "validationStatus",
  ]);
  assert.equal(envelope.data.repository, "rangabot");
  assert.equal(envelope.data.dirty, false);
  assert.equal(envelope.data.sourceStatus, "COMPLETE");
  assert.equal(envelope.data.validationStatus, "VALID");
  assert.doesNotMatch(JSON.stringify(envelope), /turnId|prompt|responseText|title|reason|memory|attachment|user|device|model/i);
  assert.throws(() => buildResponseFeedbackDailyEnvelope({
    build: "0.1.0+rfp.abcdef123456",
    buildDigest: "a".repeat(64),
    sourceVersion: "0.1.0",
    day: yesterday,
    counts: { eligibleResponses: 1, helpful: 1, needsImprovement: 1, rated: 1, unrated: 0 },
  }), /counts are inconsistent/);
  assert.throws(() => buildResponseFeedbackDailyEnvelope({
    build: "0.1.0+rfp.abcdef123456",
    buildDigest: "a".repeat(64),
    sourceVersion: "0.1.0",
    day: "2026-02-30",
    counts: { eligibleResponses: 0, helpful: 0, needsImprovement: 0, rated: 0, unrated: 0 },
  }), /real UTC calendar day/);
  const today = new Date().toISOString().slice(0, 10);
  assert.throws(() => buildResponseFeedbackDailyEnvelope({
    build: "0.1.0+rfp.abcdef123456",
    buildDigest: "a".repeat(64),
    sourceVersion: "0.1.0",
    day: today,
    counts: { eligibleResponses: 0, helpful: 0, needsImprovement: 0, rated: 0, unrated: 0 },
  }), /only after its UTC window closes/);
  assert.throws(() => buildResponseFeedbackDailyEnvelope({
    build: "0.1.0+rfp.abcdef123456",
    buildDigest: "a".repeat(64),
    sourceVersion: "0.1.0",
    day: yesterday,
    counts: { eligibleResponses: 0, helpful: 0, needsImprovement: 0, rated: 0, unrated: 0 },
    generatedAt: new Date(Date.now() + 301_000),
  }), /only after its UTC window closes/);
  assert.match(readFileSync("scripts/export-response-feedback.ts", "utf8"), /buildDigest: candidate\.candidateBuildId/);
});

test("UI wiring is completed-turn only, same-origin, accessible, and content-free", () => {
  const page = readFileSync("app/page.tsx", "utf8");
  const component = readFileSync("app/components/response-feedback.tsx", "utf8");
  const css = readFileSync("app/globals.css", "utf8");
  assert.match(page, /message\.role === "assistant" && message\.turn\?\.status === "completed"/);
  assert.match(page, /activeConversationId && !publicDemo/);
  assert.match(page, /Object\.prototype\.hasOwnProperty\.call\(responseFeedback, message\.turn\.id\)/);
  assert.match(page, /applyResponseFeedbackRead\(/);
  assert.match(page, /responseFeedbackBindingMatches/);
  assert.match(page, /mergeResponseFeedbackRead/);
  assert.match(page, /updateResponseFeedbackForConversation/);
  assert.match(component, /<fieldset className="response-feedback"/);
  assert.match(component, /<legend>Was this response helpful\?<\/legend>/);
  assert.match(component, /Helpful/);
  assert.match(component, /Needs improvement/);
  assert.match(component, /aria-pressed/);
  assert.match(component, /aria-live="polite"/);
  assert.match(component, /localApiFetch/);
  assert.doesNotMatch(component, /\bfetch\(|responseText|prompt|training|regenerat/i);
  assert.match(css, /\.response-feedback-options button \{[^}]*min-height: 44px/);
  assert.match(css, /\.response-feedback-options \{[^}]*flex-wrap: wrap/);
  assert.match(css, /button\.selected \{[^}]*border-width: 2px/);
  assert.match(css, /\.response-feedback-check/);
});
