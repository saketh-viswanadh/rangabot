import assert from "node:assert/strict";
import test from "node:test";
import { compileAnswerContract } from "../lib/conversation-contract.ts";
import {
  auditFinishedAnswer,
  buildFinishRepairMessages,
  chooseFinishedAnswer,
  deriveArithmeticFacts,
  deriveFinishVerificationPlan,
  deterministicArithmeticAnswer,
  finishVerificationReceipt,
} from "../lib/finish-verification.ts";
import type { ChatMessage } from "../lib/providers/types.ts";

function fixture(request: string) {
  const messages: ChatMessage[] = [{ role: "user", content: request }];
  const contract = compileAnswerContract(messages);
  return { contract, plan: deriveFinishVerificationPlan(contract) };
}

test("derives exact arithmetic and returns a deterministic answer without model generation", () => {
  assert.deepEqual(deriveArithmeticFacts("Calculate 24 - (8 × 2)?"), [{ expression: "24 - (8 × 2)", result: "8" }]);
  assert.deepEqual(deriveArithmeticFacts("Calculate 0.1 + 0.2"), [{ expression: "0.1 + 0.2", result: "0.3" }]);
  assert.deepEqual(deriveArithmeticFacts("Calculate 1 / 8"), [{ expression: "1 / 8", result: "0.125" }]);
  const { contract, plan } = fixture("Calculate 24 - (8 × 2)?");
  assert.equal(plan.shouldVerify, true);
  assert.equal(deterministicArithmeticAnswer(plan), "The verified result is 8.");
  assert.equal(auditFinishedAnswer("The result is 10.", plan, contract).some((issue) => issue.code === "arithmetic"), true);
  assert.deepEqual(auditFinishedAnswer("The result is 8.", plan, contract), []);
});

test("declines arithmetic that cannot be represented exactly inside the bounded evaluator", () => {
  for (const request of [
    "Calculate 9007199254740993 - 9007199254740992",
    "Calculate 1 / 300000000",
    "Calculate 0.000000001% of 1",
    "Calculate 0x10",
    "Calculate ０ｘ１０",
    "Calculate 2²",
    "Calculate 10²",
    "Calculate 2⁻¹",
    "Calculate 10⁻²",
    "Calculate 5!",
    "Calculate (3 + 2)!",
    "Calculate 0!",
    "Calculate 2 + 3!",
    "Calculate 1 / 3",
  ]) {
    assert.deepEqual(deriveArithmeticFacts(request), [], request);
    assert.equal(deterministicArithmeticAnswer(fixture(request).plan), null, request);
  }
});

test("supported percentages reject every noncanonical or contradictory conclusion", () => {
  assert.deepEqual(deriveArithmeticFacts("Calculate 10% of 250"), [{ expression: "10% of 250", result: "25" }]);
  const percentage = fixture("Calculate 10% of 250");
  assert.equal(percentage.plan.checks.includes("arithmetic"), true);
  for (const answer of [
    "The answer is 300.",
    "The expected result is 25, but I conclude 300.",
    "I conclude 42. The expected check value is 25.",
    "The answer is three hundred.",
    "25, but that result is wrong.",
    "Final answer: NaN",
    "First, 10 / 100 = 0.1. Then, 0.1 × 250 = 25.",
  ]) assert.equal(auditFinishedAnswer(answer, percentage.plan, percentage.contract).some((issue) => issue.code === "arithmetic"), true, answer);
  assert.deepEqual(auditFinishedAnswer("The verified result is 25.", percentage.plan, percentage.contract), []);
  const unsupported = fixture("Calculate the weighted score from the values I described earlier.");
  assert.equal(unsupported.plan.checks.includes("arithmetic"), false);
  assert.equal(unsupported.plan.shouldVerify, false);
  assert.deepEqual(deriveArithmeticFacts("Calculate 10% of 250. Return exactly two sentences."), []);
});

test("checks exact writing requirements and completion", () => {
  const { contract, plan } = fixture("Write exactly four bullet points about backups.");
  assert.equal(auditFinishedAnswer("- One\n- Two\n- Three", plan, contract).some((issue) => issue.code === "list-count"), true);
  assert.deepEqual(auditFinishedAnswer("- One\n- Two\n- Three\n- Four", plan, contract), []);
  assert.equal(auditFinishedAnswer("- One\n- Two\n- Three\n- Four...", plan, contract).some((issue) => issue.code === "incomplete"), true);
  assert.equal(auditFinishedAnswer("- ​\n- ​\n- ​\n- ​", plan, contract).some((issue) => issue.code === "list-count"), true);
  assert.equal(auditFinishedAnswer("- One\n- Two\n- &nbsp;\n- &#160;", plan, contract).some((issue) => issue.code === "list-count"), true);
  assert.equal(auditFinishedAnswer("- One\n- Two\n- [x]: /url\n- <!-- hidden -->", plan, contract).some((issue) => issue.code === "list-count"), true);
  assert.equal(auditFinishedAnswer("- One\n- Two\n- \u3164\n- \uFFA0", plan, contract).some((issue) => issue.code === "list-count"), true);
  assert.equal(auditFinishedAnswer("```text\n- One\n- Two\n- Three\n- Four\n```", plan, contract).some((issue) => issue.code === "list-count"), true);
  const words = fixture("Write exactly five words about testing.");
  assert.equal(auditFinishedAnswer("! ! ! ! !", words.plan, words.contract).some((issue) => issue.code === "word-count"), true);
  assert.equal(auditFinishedAnswer("One two three four &nbsp;", words.plan, words.contract).some((issue) => issue.code === "word-count"), true);
  assert.equal(auditFinishedAnswer("One two three four\n[x]: /url", words.plan, words.contract).some((issue) => issue.code === "word-count"), true);
  assert.equal(auditFinishedAnswer("One two three four \u3164", words.plan, words.contract).some((issue) => issue.code === "word-count"), true);
  const lowercase = fixture("Write exactly five lowercase words.");
  assert.equal(auditFinishedAnswer("one &#84;wo three four five", lowercase.plan, lowercase.contract).some((issue) => issue.code === "format"), true);
  assert.equal(auditFinishedAnswer("ǅuro is ready right now", lowercase.plan, lowercase.contract).some((issue) => issue.code === "format"), true);
  const sentences = fixture("Write exactly two sentences.");
  assert.equal(auditFinishedAnswer(". .", sentences.plan, sentences.contract).some((issue) => issue.code === "sentence-count"), true);
  const oneSentence = fixture("Write exactly one sentence.");
  assert.deepEqual(auditFinishedAnswer("Dr. Maya joined.", oneSentence.plan, oneSentence.contract), []);
  assert.equal(auditFinishedAnswer("First sentence. Second sentence", oneSentence.plan, oneSentence.contract).some((issue) => issue.code === "sentence-count"), true);
  assert.equal(auditFinishedAnswer("First. Second. Third without punctuation", sentences.plan, sentences.contract).some((issue) => issue.code === "sentence-count"), true);
  for (const twoSentences of ["Use backups, etc. They reduce risk.", "I met Dr. She was helpful.", "I visited St. It was quiet.", "Ask Prof. Then continue.", "She said “Go.” He left.", 'She said "Go." He left.']) {
    assert.equal(auditFinishedAnswer(twoSentences, oneSentence.plan, oneSentence.contract).some((issue) => issue.code === "sentence-count"), true, twoSentences);
  }
  for (const one of ["Use backups, e.g. snapshots.", "Use snapshots, i.e. point-in-time copies.", "Meet at 5 p.m. tomorrow.", "See Fig. 2 for details.", "Ask Dr. van Helsing."]) {
    assert.deepEqual(auditFinishedAnswer(one, oneSentence.plan, oneSentence.contract), [], one);
  }
  for (const ambiguous of [
    "The U.S. Army responded.",
    "Our U.S. Army responded.",
    "Officials from the U.S. Army responded.",
    "The U.S. Supreme Court ruled.",
    "Our U.N. Security Council met.",
    "The U.S. He responded.",
    "The U.S. This happened next.",
    "The U.S. Canada was next.",
    "The U.S. However, Canada followed.",
    "They arrived in the U.S. Army officials responded.",
    "He visited the U.S. Congress reconvened.",
  ]) {
    const issues = auditFinishedAnswer(ambiguous, oneSentence.plan, oneSentence.contract);
    assert.equal(issues.some((issue) => issue.message.includes("ambiguous boundary")), true, ambiguous);
  }
  const ambiguousIssues = auditFinishedAnswer("The U.S. Army responded.", oneSentence.plan, oneSentence.contract);
  assert.deepEqual(finishVerificationReceipt(oneSentence.plan, false, ambiguousIssues), {
    version: "finish-v1",
    status: "warning",
    checks: ["completion", "requirements"],
    issueCount: 1,
    manualReview: "ambiguous-sentence-boundary",
  });
  for (const twoSentences of ["He visited the U.S. Canada was next.", "The policy changed in the U.S. However, Canada differed.", "She moved to the U.K. France was next.", "We cited the U.N. NATO responded."]) {
    assert.equal(auditFinishedAnswer(twoSentences, oneSentence.plan, oneSentence.contract).some((issue) => issue.code === "sentence-count"), true, twoSentences);
  }
  for (const one of ["Welcome to the\nteam.", "This is one long\nsentence without a period", "Dr. Maya\njoined the team."]) {
    assert.deepEqual(auditFinishedAnswer(one, oneSentence.plan, oneSentence.contract), [], one);
  }
  const complete = fixture("Write a complete short reply.");
  for (const invisible of [".", "!", "—", "\u200B", "\u2060", "\u2800", "\u3164", "\uFFA0", "\u115F", "\u1160", "&nbsp;", "&#160;", "<!-- hidden -->"]) {
    assert.equal(auditFinishedAnswer(invisible, complete.plan, complete.contract).some((issue) => issue.code === "incomplete"), true, JSON.stringify(invisible));
  }
  assert.equal(auditFinishedAnswer("Draft [to be continued]", complete.plan, complete.contract).some((issue) => issue.code === "incomplete"), true);
  for (const unfinished of ["Draft [continued below]", "Part 1 of 2: The first point is ready.", "The migration continues… (more below)"]) {
    assert.equal(auditFinishedAnswer(unfinished, complete.plan, complete.contract).some((issue) => issue.code === "incomplete"), true, unfinished);
  }
  for (const unfinished of [
    'The migration continues…"',
    "The migration *continues…*",
    "[continues…](https://example.com)",
    "Draft T&#79;DO",
    "Draft T**OD**O",
    "Draft [to be **continued**]",
    "Part **1** of **2**: first section.",
    "More **below**",
    "Draft [continued](https://example.com)",
    "Draft [truncated](https://example.com)",
    "Draft [to be continued](https://example.com)",
    "Draft [continue](https://example.com)",
    "Draft [continued][x]\n\n[x]: https://example.com",
    "Draft [truncated][x]\n\n[x]: https://example.com",
    "Draft [to be continued][x]\n\n[x]: https://example.com",
    "Draft [continue][x]\n\n[x]: https://example.com",
    "Draft [continued soon](https://example.com)",
    "Draft ([continued](https://example.com))",
    "Draft “[continued](https://example.com)”",
    "Draft ([continued soon](https://example.com))",
    "Draft ([continued][x])\n\n[x]: https://example.com",
    "Draft [continued](https://example.com) —",
    "Draft [continued shortly](https://example.com)",
    "[continued](https://example.com)",
    "To be [continued](https://example.com)",
    "Draft [continued in the next message](https://example.com)",
    "Draft [continued in next message](https://example.com)",
    "Draft [continued here](https://example.com)",
  ]) assert.equal(auditFinishedAnswer(unfinished, complete.plan, complete.contract).some((issue) => issue.code === "incomplete"), true, unfinished);
  assert.deepEqual(auditFinishedAnswer("The work [continued](https://example.com) successfully.", complete.plan, complete.contract), []);
  assert.deepEqual(auditFinishedAnswer("The work [continued](https://example.com).", complete.plan, complete.contract), []);
  assert.deepEqual(auditFinishedAnswer("The show [continued shortly](https://example.com).", complete.plan, complete.contract), []);
  const forbidden = fixture('Write a reply. Do not mention the phrase "secret".');
  assert.deepEqual(forbidden.contract.forbiddenTerms, ["secret"]);
  assert.equal(auditFinishedAnswer("Secret remains.", forbidden.plan, forbidden.contract).some((issue) => issue.code === "forbidden-term"), true);
  assert.equal(auditFinishedAnswer("s&#101;cret remains.", forbidden.plan, forbidden.contract).some((issue) => issue.code === "forbidden-term"), true);
  assert.equal(auditFinishedAnswer("se**cr**et remains.", forbidden.plan, forbidden.contract).some((issue) => issue.code === "forbidden-term"), true);
  const forbiddenWord = fixture('Write a reply. Do not mention the word "cat".');
  assert.equal(auditFinishedAnswer("Concatenate the strings.", forbiddenWord.plan, forbiddenWord.contract).some((issue) => issue.code === "forbidden-term"), false);
  assert.equal(auditFinishedAnswer("The cat remains.", forbiddenWord.plan, forbiddenWord.contract).some((issue) => issue.code === "forbidden-term"), true);
  const noBullets = fixture("Write a short update with no bullets.");
  for (const answer of ["• One\n• Two", "‣ One\n‣ Two", "◦ One\n◦ Two", "▪ One\n▪ Two", "● One\n● Two", "⁃ One\n⁃ Two", "▶ One\n▶ Two", "▷ One\n▷ Two", "➤ One\n➤ Two", "❖ One\n❖ Two", "▫ One\n▫ Two", "☞ One\n☞ Two"]) {
    assert.equal(auditFinishedAnswer(answer, noBullets.plan, noBullets.contract).some((issue) => issue.code === "format"), true, answer);
  }
  for (const answer of ["▶️ One\n▶️ Two", "**▶** One\n**▶** Two", "&#9654; One\n&#9654; Two"]) {
    assert.equal(auditFinishedAnswer(answer, noBullets.plan, noBullets.contract).some((issue) => issue.code === "format"), true, answer);
  }
  assert.equal(auditFinishedAnswer("➢ One\n➣ Two", noBullets.plan, noBullets.contract).some((issue) => issue.code === "format"), true);
  for (const answer of ["₹ 100\n₹ 200", "“ Alpha\n“ Beta", "© 2025\n© 2026", "§ 1\n§ 2"]) {
    assert.equal(auditFinishedAnswer(answer, noBullets.plan, noBullets.contract).some((issue) => issue.code === "format"), false, answer);
  }
  assert.deepEqual(auditFinishedAnswer("~~~text\n▶ One\n▶ Two\n~~~", noBullets.plan, noBullets.contract), []);
});

test("checks only for complete non-empty fenced code without claiming language parsing", () => {
  const { contract, plan } = fixture("Write a JavaScript function that adds two numbers.");
  assert.equal(plan.checks.includes("code-structure"), true);
  assert.equal(fixture("Write documentation and a Python function.").plan.codeRequested, true);
  assert.equal(fixture("Write documentation along with a Python function.").plan.codeRequested, true);
  assert.equal(fixture("Write documentation as well as a Python function.").plan.codeRequested, true);
  assert.equal(fixture("Write documentation with a Python function.").plan.codeRequested, true);
  assert.equal(fixture("Write documentation including a Python function.").plan.codeRequested, true);
  assert.equal(fixture("Write documentation containing a Python function.").plan.codeRequested, true);
  assert.equal(fixture("Write documentation, then include a Python function.").plan.codeRequested, true);
  assert.equal(fixture("Write a report and include a JavaScript function.").plan.codeRequested, true);
  assert.equal(fixture("Draft an email containing a SQL query.").plan.codeRequested, true);
  assert.equal(fixture("Write documentation with an example Python function.").plan.codeRequested, true);
  assert.equal(fixture("Write a Python function overview and implementation.").plan.codeRequested, true);
  assert.equal(fixture("Write a Python function overview and implementation plan.").plan.codeRequested, false);
  for (const planningRequest of [
    "Write an implementation plan for a Python function.",
    "Create an implementation roadmap for a TypeScript component.",
    "Draft a migration plan for the SQL query.",
    "Plan how to implement it in Python.",
    "Give me a roadmap to implement this using JavaScript.",
  ]) assert.equal(fixture(planningRequest).plan.codeRequested, false, planningRequest);
  assert.equal(fixture("Write a Python function and its implementation.").plan.codeRequested, true);
  assert.equal(fixture("Implement it in Python.").plan.codeRequested, true);
  assert.equal(fixture("Write a Python function overview.").plan.codeRequested, false);
  assert.equal(fixture("Write a function name.").plan.codeRequested, false);
  assert.equal(auditFinishedAnswer("Use an addition function.", plan, contract).some((issue) => issue.code === "missing-code"), true);
  assert.equal(auditFinishedAnswer("```javascript\n  \n```", plan, contract).some((issue) => issue.code === "code-structure"), true);
  assert.equal(auditFinishedAnswer("```javascript\nfunction add(a, b) { return a + b;", plan, contract).some((issue) => issue.code === "incomplete"), true);
  assert.equal(auditFinishedAnswer("```javascript\nconst marker = \"```\";", plan, contract).some((issue) => issue.code === "incomplete"), true);
  assert.equal(auditFinishedAnswer("```javascript\nconst ready = true;\n```junk", plan, contract).some((issue) => issue.code === "incomplete"), true);
  assert.equal(auditFinishedAnswer("````javascript\nconst ready = true;\n```", plan, contract).some((issue) => issue.code === "incomplete"), true);
  assert.equal(auditFinishedAnswer("Try ```javascript\nconst ready = true;\n```", plan, contract).some((issue) => issue.code === "missing-code"), true);
  assert.equal(auditFinishedAnswer("    ```javascript\nconst ready = true;\n    ```", plan, contract).some((issue) => issue.code === "missing-code"), true);
  assert.equal(auditFinishedAnswer("\t```javascript\nconst ready = true;\n\t```", plan, contract).some((issue) => issue.code === "missing-code"), true);
  assert.deepEqual(auditFinishedAnswer("```javascript\nfunction add(a, b) { return a + b;\n```", plan, contract), []);
  assert.deepEqual(auditFinishedAnswer("```javascript\nfunction add(a, b) { return a + b; }\n```", plan, contract), []);
  assert.deepEqual(auditFinishedAnswer("   ```javascript\nfunction add(a, b) { return a + b; }\n   ```", plan, contract), []);
  assert.deepEqual(auditFinishedAnswer("~~~~javascript\nfunction add(a, b) { return a + b; }\n~~~~", plan, contract), []);
  assert.deepEqual(auditFinishedAnswer("````javascript\nfunction add(a, b) { return a + b; }\n````", plan, contract), []);
  assert.deepEqual(auditFinishedAnswer("```javascript\nconst TODO = \"literal\";\n```", plan, contract), []);
  assert.deepEqual(auditFinishedAnswer("```json\n{}\n```", plan, contract), []);
  assert.equal(auditFinishedAnswer("```text\n\u3164\n```", plan, contract).some((issue) => issue.code === "code-structure"), true);
  assert.equal(auditFinishedAnswer("```text\n\u2800\n```", plan, contract).some((issue) => issue.code === "code-structure"), true);
  for (const advice of ["What is Python code?", "Explain JavaScript code to a beginner.", "Tell me about TypeScript code.", "Compare Python code and JavaScript code.", "Write a short explanation of Python.", "Write a paragraph comparing JavaScript and TypeScript.", "Draft an email about our SQL training.", "Create a study plan for learning Java.", "Write an explanation of what a function is.", "Draft an email about our new component.", "Write documentation for this class.", "Write a description of the program.", "Draft a memo about the deployment script."]) {
    assert.equal(fixture(advice).plan.codeRequested, false, advice);
  }
});

test("preserves exact user-supplied revision text", () => {
  const { contract, plan } = fixture('Rewrite this note but preserve "safe_mode = true" exactly.');
  assert.equal(auditFinishedAnswer("The setting remains enabled.", plan, contract).some((issue) => issue.code === "preservation"), true);
  assert.deepEqual(auditFinishedAnswer("Updated note: safe_mode = true", plan, contract), []);
  assert.equal(auditFinishedAnswer("[safe_mode = true]: /url", plan, contract).some((issue) => issue.code === "preservation"), true);
  for (const request of ['Do not include "secret".', 'Do not mention "password".']) {
    const negated = fixture(request);
    assert.deepEqual(negated.plan.requiredLiterals, [], request);
    assert.equal(negated.plan.checks.includes("preservation"), false, request);
  }
  assert.deepEqual(fixture('Do not change "safe_mode = true".').plan.requiredLiterals, ["safe_mode = true"]);
  for (const advice of ['Should I include "confidential"?', 'Is it okay to include "x"?', 'Would it be wise to mention "x"?', 'Why mention "x"?', 'Who should mention "x"?', 'What is the best way to include "x"?']) {
    assert.deepEqual(fixture(advice).plan.requiredLiterals, [], advice);
  }
  for (const advice of ['Can you explain whether to include "x"?', 'Could you advise me whether I should mention "x"?', 'Would you tell me if it is wise to include "x"?', 'Can you discuss why one might include "x"?']) {
    assert.deepEqual(fixture(advice).plan.requiredLiterals, [], advice);
  }
  assert.deepEqual(fixture('Could you include "approved" exactly?').plan.requiredLiterals, ["approved"]);
});

test("does not claim semantic preservation for arbitrary facts or relationships", () => {
  const { plan } = fixture("Write four bullets. Owner: Maya, launch date: September 2, budget: ₹5,000.");
  assert.equal(plan.checks.includes("preservation"), false);
  assert.deepEqual(plan.requiredLiterals, []);
});

test("accepts only a content-identical list-format repair", () => {
  const { contract, plan } = fixture("Write exactly three bullet points about backups.");
  const original = "One\nTwo\nThree";
  const issues = auditFinishedAnswer(original, plan, contract);
  assert.equal(issues.some((issue) => issue.code === "list-count"), true);
  assert.notEqual(buildFinishRepairMessages([{ role: "user", content: contract.latestRequest }], original, issues), null);
  const worse = chooseFinishedAnswer(original, "Draft...", plan, contract);
  assert.equal(worse.answer, original);
  assert.equal(worse.repaired, false);
  const better = chooseFinishedAnswer(original, "- One\n- Two\n- Three", plan, contract);
  assert.equal(better.repaired, true);
  assert.deepEqual(better.issues, []);
  assert.deepEqual(finishVerificationReceipt(plan, true, better.issues), {
    version: "finish-v1",
    status: "repaired",
    checks: ["completion", "requirements"],
    issueCount: 0,
  });
  const inlineCodeOriginal = "`a  b`\nReady\nDone";
  const inlineCodeIssues = auditFinishedAnswer(inlineCodeOriginal, plan, contract);
  assert.equal(buildFinishRepairMessages([{ role: "user", content: contract.latestRequest }], inlineCodeOriginal, inlineCodeIssues), null);
  assert.equal(chooseFinishedAnswer(inlineCodeOriginal, "- `a b`\n- Ready\n- Done", plan, contract).repaired, false);
});

test("rejects every repair that adds, removes, rewrites, or reorders content", () => {
  const { contract, plan } = fixture("We launch Friday. Priya deploys it. QA signs off Thursday. Rollback needs two approvals. Return exactly four bullets.");
  const original = "Launch Friday\nPriya deploys it\nQA signs off Thursday\nRollback needs two approvals";
  for (const candidate of [
    "- Launch Friday\n- QA deploys it\n- Priya signs off Thursday\n- Rollback needs two approvals",
    "- Launch Friday\n- Priya confirms QA deploys it\n- QA confirms Priya signs off Thursday\n- Rollback needs two approvals",
    "- Launch Friday\n- Priya deploys it\n- QA signs off Thursday\n- Rollback needs two approvals\n- Ready",
    "- Priya deploys it\n- Launch Friday\n- QA signs off Thursday\n- Rollback needs two approvals",
  ]) assert.equal(chooseFinishedAnswer(original, candidate, plan, contract).repaired, false, candidate);
  const arithmetic = fixture("Calculate 10% of 250");
  const arithmeticIssues = auditFinishedAnswer("The answer is 300.", arithmetic.plan, arithmetic.contract);
  assert.equal(buildFinishRepairMessages([{ role: "user", content: arithmetic.contract.latestRequest }], "The answer is 300.", arithmeticIssues), null);
  const noBullets = fixture("Write a short update with no bullets.");
  for (const renderedList of ["> - One", "> 1. One"]) {
    assert.equal(auditFinishedAnswer(renderedList, noBullets.plan, noBullets.contract).some((issue) => issue.code === "format"), true, renderedList);
  }
  assert.deepEqual(auditFinishedAnswer("    - indented code, not list", noBullets.plan, noBullets.contract), []);
  const year = "2026. Revenue increased.";
  const yearIssues = auditFinishedAnswer(year, noBullets.plan, noBullets.contract);
  assert.equal(yearIssues.some((issue) => issue.code === "format"), true);
  assert.equal(buildFinishRepairMessages([{ role: "user", content: noBullets.contract.latestRequest }], year, yearIssues), null);
  assert.equal(chooseFinishedAnswer(year, "Revenue increased.", noBullets.plan, noBullets.contract).repaired, false);
  const numbered = fixture("Write exactly three numbered checks.");
  const numberedDraft = "Create it\nVerify it\nRestore it";
  const numberedIssues = auditFinishedAnswer(numberedDraft, numbered.plan, numbered.contract);
  assert.equal(buildFinishRepairMessages([{ role: "user", content: numbered.contract.latestRequest }], numberedDraft, numberedIssues), null);
  const bullets = fixture("Write exactly two bullet points.");
  assert.equal(auditFinishedAnswer("    - One\n    - Two", bullets.plan, bullets.contract).some((issue) => issue.code === "list-count"), true);
  assert.deepEqual(auditFinishedAnswer("- ✅\n- Ready", bullets.plan, bullets.contract), []);
  const fenced = fixture("Write exactly two bullet points with a code example.");
  const fencedDraft = "One\nTwo\n```python\nif ready:\n    run()\n```";
  const fencedIssues = auditFinishedAnswer(fencedDraft, fenced.plan, fenced.contract);
  assert.equal(buildFinishRepairMessages([{ role: "user", content: fenced.contract.latestRequest }], fencedDraft, fencedIssues), null);
  assert.equal(chooseFinishedAnswer(fencedDraft, "- One\n- Two\n```python\nif ready:\nrun()\n```", fenced.plan, fenced.contract).repaired, false);
  const tildeDraft = "One\nTwo\n~~~python\n  if ready:\n    run()\n~~~";
  const tildeIssues = auditFinishedAnswer(tildeDraft, fenced.plan, fenced.contract);
  assert.equal(buildFinishRepairMessages([{ role: "user", content: fenced.contract.latestRequest }], tildeDraft, tildeIssues), null);
  assert.equal(chooseFinishedAnswer(tildeDraft, "- One\n- Two\n~~~python\nif ready:\nrun()\n~~~", fenced.plan, fenced.contract).repaired, false);
});

test("does not add latency to unconstrained conversational answers", () => {
  const { plan } = fixture("Explain photosynthesis to me.");
  assert.equal(plan.shouldVerify, false);
  assert.deepEqual(plan.checks, ["completion"]);
});
