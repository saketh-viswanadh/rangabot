import assert from "node:assert/strict";
import test from "node:test";
import { auditGroundedAnswer, buildGroundingRevisionInstruction, generateGroundedTeacherAnswer } from "../lib/knowledge-grounding.ts";

const sources = [
  { title: "Statistics", path: "/statistics", chunk: 1, score: 1, content: "Cross-validation estimates model performance on unseen data by repeatedly separating training and validation observations." },
  { title: "Python", path: "/python", chunk: 2, score: .9, content: "Python catches runtime exceptions with try and except clauses." },
];

test("passes a cited answer whose claims overlap the applicable evidence", () => {
  const audit = auditGroundedAnswer("Cross-validation estimates model performance on unseen observations by separating training and validation data. [Source 1]", sources);
  assert.equal(audit.passed, true);
  assert.equal(audit.citationCoverage, 1);
  assert.equal(audit.supportedCitationRate, 1);
});

test("detects missing, invalid, and weak citations", () => {
  const answer = `Cross-validation is always unbiased and guarantees perfect performance.

Python uses a magical compiler located permanently on the distant Moon for every program. [Source 2]

This claim cites a source that does not exist. [Source 9]`;
  const audit = auditGroundedAnswer(answer, sources);
  assert.equal(audit.passed, false);
  assert.deepEqual(audit.invalidCitations, [9]);
  assert.ok(audit.uncitedParagraphs >= 1);
  assert.ok(audit.weaklySupportedParagraphs >= 1);
  assert.match(buildGroundingRevisionInstruction(audit), /Never invent a source number/);
});

test("does not demand vault citations inside an explicit local-model background section", () => {
  const audit = auditGroundedAnswer(`# Vault explanation

Python catches runtime exceptions with try and except clauses. [Source 2]

## Local model background

Additional uncited context belongs here and is clearly separated from the retrieved evidence.`, sources);
  assert.equal(audit.passed, true);
});

test("revises a weak draft once and returns the grounded result", async () => {
  const completions = [
    "Cross-validation guarantees a perfect model every time.",
    "Cross-validation estimates performance on unseen data by separating training and validation observations. [Source 1]",
  ];
  const result = await generateGroundedTeacherAnswer(
    [{ role: "user", content: "Explain cross-validation" }],
    sources,
    async () => completions.shift() ?? "",
  );
  assert.equal(result.revised, true);
  assert.equal(result.audit.passed, true);
  assert.match(result.answer, /\[Source 1\]/);
  assert.doesNotMatch(result.answer, /Grounding note/);
});

test("shows a warning when the single revision remains ungrounded", async () => {
  const result = await generateGroundedTeacherAnswer(
    [{ role: "user", content: "Explain cross-validation" }],
    sources,
    async () => "This unsupported factual explanation has no usable citation and remains unreliable.",
  );
  assert.equal(result.revised, true);
  assert.equal(result.audit.passed, false);
  assert.match(result.answer, /Grounding note/);
});
