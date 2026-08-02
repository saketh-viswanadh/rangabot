import assert from "node:assert/strict";
import test from "node:test";
import { reviewerQualificationCases, scoreReviewerQualification } from "../lib/reviewer-qualification.ts";

test("freezes balanced good and bad reviewer qualification cases", () => {
  assert.equal(reviewerQualificationCases.length, 12);
  assert.equal(reviewerQualificationCases.filter((item) => item.expected === "pass").length, 6);
  assert.equal(reviewerQualificationCases.filter((item) => item.expected === "revise").length, 6);
});

test("requires correction of bad drafts and preservation of good drafts", () => {
  const bad = reviewerQualificationCases.find((item) => item.id === "bad-arithmetic")!;
  assert.equal(scoreReviewerQualification(bad, { answer: "12 / 3 = 4.", status: "revised", issues: ["wrong arithmetic"] }).passed, true);
  assert.equal(scoreReviewerQualification(bad, { answer: bad.draft, status: "passed", issues: [] }).passed, false);
  const good = reviewerQualificationCases.find((item) => item.id === "good-data-locality")!;
  assert.equal(scoreReviewerQualification(good, { answer: good.draft, status: "passed", issues: [] }).passed, true);
  assert.equal(scoreReviewerQualification(good, { answer: "Use Python.", status: "revised", issues: [] }).passed, false);
});
