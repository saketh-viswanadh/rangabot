import assert from "node:assert/strict";
import test from "node:test";
import { auditGroundedAnswer, buildGroundingRevisionInstruction, generateGroundedTeacherAnswer, separateGroundedEvidence } from "../lib/knowledge-grounding.ts";

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

test("uses fast deterministic separation before requesting a second generation", async () => {
  let calls = 0;
  const result = await generateGroundedTeacherAnswer(
    [{ role: "user", content: "Explain cross-validation" }],
    sources,
    async () => {
      calls += 1;
      return "Cross-validation estimates model performance on unseen data by separating training and validation observations. [Source 1]\n\nThis broader practical guidance is useful but is not covered by the retrieved passage.";
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.revised, false);
  assert.equal(result.separated, true);
  assert.equal(result.audit.passed, true);
  assert.match(result.answer, /## Vault-grounded answer/);
  assert.match(result.answer, /## Local model background/);
});

test("revises a weak draft once when deterministic separation cannot establish grounding", async () => {
  const completions = [
    "This unsupported factual explanation has no usable citation and remains unreliable.",
    "Cross-validation estimates performance on unseen data by separating training and validation observations. [Source 1]",
  ];
  const result = await generateGroundedTeacherAnswer(
    [{ role: "user", content: "Explain cross-validation" }],
    sources,
    async () => completions.shift() ?? "",
  );
  assert.equal(result.revised, true);
  assert.equal(result.separated, false);
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

test("normalizes a small model's bare numbered citation markers", async () => {
  const result = await generateGroundedTeacherAnswer(
    [{ role: "user", content: "Explain exceptions" }],
    sources,
    async () => "Python catches runtime exceptions with try and except clauses. [2]",
  );
  assert.equal(result.audit.passed, true);
  assert.match(result.answer, /\[Source 2\]/);
});

test("treats bold subsections after Local model background as model knowledge", () => {
  const audit = auditGroundedAnswer(`Cross-validation estimates model performance on unseen data by separating training and validation observations. [Source 1]

**Local Model Background**

This stable explanation is deliberately uncited model knowledge.

**Example**

This example remains part of the explicitly labelled background section.`, sources);
  assert.equal(audit.passed, true);
  assert.equal(audit.uncitedParagraphs, 0);
});

test("separates supported vault claims from unverified model explanation", () => {
  const separated = separateGroundedEvidence(`Cross-validation estimates performance on unseen data by separating training and validation observations. [Source 1]

This uncited statement may still be useful but is not vault verified.`, sources);
  assert.match(separated, /## Vault-grounded answer/);
  assert.match(separated, /\[Source 1\]/);
  assert.match(separated, /## Local model background/);
  assert.match(separated, /not verified/);
  assert.equal(auditGroundedAnswer(separated, sources).passed, true);
});

test("attaches an isolated source marker to the preceding factual paragraph", () => {
  const audit = auditGroundedAnswer(`Cross-validation estimates model performance on unseen data by separating training and validation observations.

[Source 1]`, sources);
  assert.equal(audit.passed, true);
  assert.equal(audit.citationCoverage, 1);
});

test("conservatively recovers a missing citation from strongly matching evidence", () => {
  const separated = separateGroundedEvidence("Python catches runtime exceptions with try and except clauses.", sources);
  assert.match(separated, /\[Source 2\]/);
  assert.equal(auditGroundedAnswer(separated, sources).passed, true);
});

test("keeps the better grounded draft when revision removes its citations", async () => {
  const completions = [
    "Cross-validation estimates model performance on unseen data by separating training and validation observations. [Source 1]\n\nThis additional factual paragraph remains completely uncited and should trigger the grounding revision process.",
    "A replacement answer that removed every useful citation and supporting detail.",
  ];
  const result = await generateGroundedTeacherAnswer([{ role: "user", content: "Explain cross-validation" }], sources, async () => completions.shift() ?? "");
  assert.match(result.answer, /\[Source 1\]/);
  assert.equal(result.audit.passed, true);
  assert.equal(result.separated, true);
  assert.equal(result.revised, false);
});
