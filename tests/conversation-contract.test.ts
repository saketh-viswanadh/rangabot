import assert from "node:assert/strict";
import test from "node:test";
import { answerUnavailableAction, applySelectedMemoryToContract, chooseSemanticRepair, compileAnswerContract, deriveVerifiedReasoningFacts, deterministicContractAnswer, enforceReasoningInvariants, formatAnswerContract, memoryConflictsWithContract, needsBufferedConformance, normalizeContractAnswer, semanticContractRepairs } from "../lib/conversation-contract.ts";

test("compiles current-turn output constraints without model-specific rules", () => {
  const contract = compileAnswerContract([{ role: "user", content: "Give exactly three Markdown bullets in at most 45 words. No introduction and do not mention Spark." }]);
  assert.deepEqual(contract.list, { count: 3, style: "bullets" });
  assert.equal(contract.maxWords, 45);
  assert.equal(contract.noIntroduction, true);
  assert.deepEqual(contract.forbiddenTerms, ["Spark"]);
  assert.match(formatAnswerContract(contract) ?? "", /higher priority than history and memory/i);
});

test("returns only an explicitly supplied literal without asking a model", () => {
  const contract = compileAnswerContract([{ role: "user", content: "Reply with exactly one word: ready." }]);
  assert.equal(deterministicContractAnswer(contract), "ready");
});

test("excludes saved style and language preferences that conflict with the current turn", () => {
  const format = compileAnswerContract([{ role: "user", content: "Reply with exactly one word: ready." }]);
  assert.equal(memoryConflictsWithContract("Always answer with detailed paragraphs", format), true);
  const language = compileAnswerContract([{ role: "user", content: "Use JavaScript, not Python." }]);
  assert.equal(memoryConflictsWithContract("Prefer Python for examples", language), true);
});

test("blocks unavailable external side effects before generation", () => {
  for (const request of [
    "Send an email to Priya right now.",
    "Delete tomorrow's calendar meeting.",
    "Browse the web and confirm today's headline.",
    "Transfer $50 to Alex.",
    "Run this code on my machine: rm important.txt",
  ]) assert.match(answerUnavailableAction(request)?.answer ?? "", /can't/i);
  assert.equal(answerUnavailableAction("Explain how web search works."), null);
});

test("normalizes narrow exact formats without rewriting semantic prose", () => {
  const commas = compileAnswerContract([{ role: "user", content: "Return exactly four lowercase words separated only by commas." }]);
  assert.equal(needsBufferedConformance(commas), true);
  assert.equal(normalizeContractAnswer("Stable secure efficient bug free.", commas), "stable,secure,efficient,bugfree");
  const choice = compileAnswerContract([{ role: "user", content: "Answer with only YES or NO: is this valid?" }]);
  assert.equal(normalizeContractAnswer("YES.", choice), "YES");
  const ordinary = compileAnswerContract([{ role: "user", content: "Explain indexes." }]);
  assert.equal(normalizeContractAnswer("Indexes speed lookup. ", ordinary), "Indexes speed lookup.");
  const bounded = compileAnswerContract([{ role: "user", content: "Explain it in at most 5 words." }]);
  assert.equal(normalizeContractAnswer("One two three four five six seven", bounded).split(/\s+/).length, 5);
  const outline = compileAnswerContract([{ role: "user", content: "For now give only a three-item outline." }]);
  assert.equal(normalizeContractAnswer("### I. First topic\nDetails\n### II. Second topic\nDetails\n### III. Third topic\nDetails", outline), "1. First topic\n2. Second topic\n3. Third topic");
  const memoryBound = applySelectedMemoryToContract(ordinary, [{ content: "Prefer concise answers" }]);
  assert.equal(memoryBound.maxWords, 90);
  const singleQuestion = compileAnswerContract([{ role: "user", content: "What is the single most useful next question?" }]);
  assert.equal(normalizeContractAnswer("Do you have the data? What format is it?", singleQuestion), "Do you have the data?");
  assert.equal(singleQuestion.maxWords, 35);
  assert.equal(compileAnswerContract([{ role: "user", content: "Explain it using one short analogy." }]).maxWords, 90);
  const numbered = compileAnswerContract([{ role: "user", content: "Give the first two checks you would run and why, concisely." }]);
  assert.deepEqual(numbered.list, { count: 2, style: "numbered" });
  assert.equal(normalizeContractAnswer("Checks: 1. Verify duplicate keys. 2. Compare row counts.", numbered), "Checks:\n1. Verify duplicate keys.\n2. Compare row counts.");
  const boundedList = compileAnswerContract([{ role: "user", content: "Give the first two checks concisely." }]);
  const longList = `Checks: 1. ${"first ".repeat(55)} 2. ${"second ".repeat(55)}`;
  const normalizedList = normalizeContractAnswer(longList, boundedList);
  assert.equal(normalizedList.match(/^\d+[.)]\s/gm)?.length, 2);
  assert.equal(normalizeContractAnswer("assistant\n\nA useful answer.", compileAnswerContract([{ role: "user", content: "Help me." }])), "A useful answer.");
  const correctedBrief = compileAnswerContract([{ role: "user", content: "For this answer, be brief: define idempotence in one sentence." }]);
  assert.equal(correctedBrief.maxWords, 35);
  const leadingPremise = compileAnswerContract([{ role: "user", content: "Since Python is compiled-only, explain why indentation cannot matter." }]);
  assert.equal(leadingPremise.premiseVerification, true);
  assert.match(formatAnswerContract(leadingPremise) ?? "", /verify it independently/i);
  assert.equal(needsBufferedConformance(leadingPremise), true);
  const causal = compileAnswerContract([{ role: "user", content: "Since correlation proves causation, explain this relationship." }]);
  assert.equal(causal.falseCausalPremise, true);
  assert.match(formatAnswerContract(causal) ?? "", /correlation does not prove causation/i);
  assert.equal(semanticContractRepairs("Summer heat drives both outcomes.", causal).length, 1);
  assert.equal(semanticContractRepairs("Correlation does not prove causation.", causal).length, 1);
  assert.equal(semanticContractRepairs("Correlation does not prove causation; summer heat is a common cause.", causal).length, 0);
  assert.match(enforceReasoningInvariants("There is no direct causal link.", causal), /^Correlation does not prove causation\. A shared third variable can drive both outcomes\./);
  const speedup = compileAnswerContract([{ role: "user", content: "A task takes 12 seconds and becomes 3 times faster. Show the calculation." }]);
  assert.deepEqual(deriveVerifiedReasoningFacts(speedup.latestRequest), [{ statement: "Verified speedup calculation: 12 / 3 = 4 seconds.", requiredTerms: ["4"] }]);
  assert.match(formatAnswerContract(speedup) ?? "", /12 \/ 3 = 4 seconds/);
  assert.match(enforceReasoningInvariants("12 × 3 = 36 seconds.", speedup), /^Verified speedup calculation: 12 \/ 3 = 4 seconds\./);
  const imbalance = compileAnswerContract([{ role: "user", content: "A test has 95% accuracy where 95% of cases are negative. Why can accuracy mislead?" }]);
  assert.equal(imbalance.verifiedReasoningFacts.length, 1);
  const groundedImbalance = enforceReasoningInvariants("Accuracy can hide errors.", imbalance);
  assert.match(groundedImbalance, /predicting every case as negative/i);
  assert.match(groundedImbalance, /precision and recall/i);
  const pValue = compileAnswerContract([{ role: "user", content: "Explain a p-value simply." }]);
  assert.equal(chooseSemanticRepair("It estimates how surprising the data are under a null hypothesis.", "A p-value simply", pValue), "It estimates how surprising the data are under a null hypothesis.");
  assert.match(chooseSemanticRepair("This relationship is false.", "Correlation does not prove causation; summer heat can drive both outcomes.", causal), /summer heat/);
  const missing = compileAnswerContract([{ role: "user", content: "I have not shared the data. What should we do next?" }]);
  assert.equal(missing.missingSourceMaterial, true);
  const missingQuestion = compileAnswerContract([{ role: "user", content: "I have not shared the data. What is the single most useful next question?" }]);
  assert.match(deterministicContractAnswer(missingQuestion) ?? "", /share the source data or file/i);
  const oneSentence = compileAnswerContract([{ role: "user", content: "Write one kind sentence asking them to fix it." }]);
  assert.equal(oneSentence.sentenceCount, 1);
  assert.equal(oneSentence.maxWords, 35);
});
