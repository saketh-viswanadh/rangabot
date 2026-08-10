import assert from "node:assert/strict";
import test from "node:test";
import { compileAnswerContract, needsBufferedConformance, normalizeContractAnswer } from "../lib/conversation-contract.ts";
import { buildConversationMessages } from "../lib/conversation-orchestration.ts";
import { deriveSemanticTaskFrame, formatSemanticTaskFrame } from "../lib/conversation-task-frame.ts";

test("preserves a named multiword concept, audience, and requested depth", () => {
  const request = "Explain event-time watermarks to a newly hired streaming engineer in plain language.";
  const frame = deriveSemanticTaskFrame(request);
  assert.deepEqual(frame, {
    intent: "explain",
    subject: "event-time watermarks",
    audience: "newly hired streaming engineer",
    depth: "plain language",
  });
  const formatted = formatSemanticTaskFrame(frame) ?? "";
  assert.match(formatted, /atomic concept/);
  assert.match(formatted, /newly hired streaming engineer/);
  assert.match(formatted, /untrusted user data/);
});

test("preserves subjects in ordinary what, how, and why questions", () => {
  assert.equal(deriveSemanticTaskFrame("What is event sourcing?")?.subject, "event sourcing");
  assert.equal(deriveSemanticTaskFrame("How does route dampening work?")?.subject, "route dampening");
  assert.equal(deriveSemanticTaskFrame("Why do bloom filters have false positives?")?.subject, "bloom filters");
});

test("frames diagnostic checks around the reported symptom rather than generic checks", () => {
  const request = "A nightly invoice reconciliation started creating three ledger entries per payment after a retry change. Give the first two checks and why.";
  const frame = deriveSemanticTaskFrame(request);
  assert.equal(frame?.intent, "diagnose");
  assert.equal(frame?.diagnosticContext, "A nightly invoice reconciliation started creating three ledger entries per payment after a retry change");
  assert.match(formatSemanticTaskFrame(frame) ?? "", /plausible causal path/);
  assert.match(formatSemanticTaskFrame(frame) ?? "", /generic setup/);
});

test("frames unseen inventory pipeline cardinality increases and decreases causally", () => {
  const increase = deriveSemanticTaskFrame("After a catalog merge, the inventory order pipeline row count became four times higher. Give the first two checks and why.");
  assert.equal(increase?.intent, "diagnose");
  assert.equal(increase?.cardinalityChange, "increase");
  const increasePrompt = formatSemanticTaskFrame(increase) ?? "";
  assert.match(increasePrompt, /identify exactly what is being counted/);
  assert.match(increasePrompt, /Where the workflow exposes stable identifiers or stages/);
  assert.match(increasePrompt, /repeated processing, one-to-many transformation/);
  assert.match(increasePrompt, /what evidence would distinguish them/);

  const decrease = deriveSemanticTaskFrame("The inventory allocation pipeline record count dropped by half after a routing change. Diagnose the loss.");
  assert.equal(decrease?.intent, "diagnose");
  assert.equal(decrease?.cardinalityChange, "decrease");
  const decreasePrompt = formatSemanticTaskFrame(decrease) ?? "";
  assert.match(decreasePrompt, /exclusion, failed matching, consolidation/);
  assert.match(decreasePrompt, /rejection, dropped observations/);
  assert.match(decreasePrompt, /only when each is plausible/);
});

test("makes composition output reader-ready while preserving tone", () => {
  const request = "Write one calm sentence asking a teammate to correct a mislabeled map legend.";
  const frame = deriveSemanticTaskFrame(request);
  assert.equal(frame?.intent, "compose");
  assert.equal(frame?.tone, "calm");
  assert.match(formatSemanticTaskFrame(frame) ?? "", /only the finished text/);
  const contract = compileAnswerContract([{ role: "user", content: request }]);
  assert.equal(contract.finishedTextOnly, true);
  assert.equal(needsBufferedConformance(contract), true);
});

test("distinguishes choice and calculation intent without domain-specific rules", () => {
  const choice = deriveSemanticTaskFrame("Choose between snapshot isolation and serializable isolation for an inventory reservation workflow, then give one reason.");
  assert.equal(choice?.intent, "choose");
  assert.equal(choice?.subject, "snapshot isolation and serializable isolation");
  assert.match(formatSemanticTaskFrame(choice) ?? "", /stated constraints/);

  const calculation = deriveSemanticTaskFrame("Calculate the percentage change from 48 to 60 and show the formula.");
  assert.equal(calculation?.intent, "calculate");
  assert.equal(calculation?.subject, "the percentage change");
  assert.match(formatSemanticTaskFrame(calculation) ?? "", /supplied values only/);
});

test("uses the first requested action for mixed requests", () => {
  assert.equal(deriveSemanticTaskFrame("Explain lease fencing, then recommend a rollout check.")?.intent, "explain");
  assert.equal(deriveSemanticTaskFrame("Recommend a lease strategy and explain the tradeoff.")?.intent, "choose");
  assert.equal(deriveSemanticTaskFrame("Do not diagnose this; explain the observed behavior.")?.intent, "explain");
});

test("requires mechanism-specific depth for an unseen expert technical concept", () => {
  const frame = deriveSemanticTaskFrame("Tell a principal storage architect, briefly, when compaction debt becomes dangerous.");
  assert.equal(frame?.subject, "compaction debt");
  assert.equal(frame?.audience, "principal storage architect");
  const formatted = formatSemanticTaskFrame(frame) ?? "";
  assert.match(formatted, /defining mechanism/);
  assert.match(formatted, /limiting resource or scale condition/);
  assert.match(formatted, /failure mode or tradeoff/);
  assert.match(formatted, /Omit any risk that would apply equally to the broader category/);
  assert.match(formatted, /explicit uncertainty/);
});

test("keeps unseen expert risk analysis distinctive and threshold-honest", () => {
  const frame = deriveSemanticTaskFrame("Tell a senior compiler engineer, concisely, when speculative inlining becomes unsafe.");
  const formatted = formatSemanticTaskFrame(frame) ?? "";
  assert.match(formatted, /distinguishes the exact named subject from its broader category/);
  assert.match(formatted, /apply equally to the broader category/);
  assert.match(formatted, /how the named mechanism amplifies it/);
  assert.match(formatted, /Never invent numeric thresholds/);
  assert.match(formatted, /qualitative conditions or explicit uncertainty/);
});

test("injects the semantic frame into generation without promoting fields to instructions", () => {
  const result = buildConversationMessages([{ role: "user", content: "Tell a veteran network operator, briefly, when route dampening becomes harmful." }]);
  const frameMessage = result.messages.find((message) => message.content.includes("SEMANTIC TASK FRAME"));
  assert.ok(frameMessage);
  assert.match(frameMessage.content, /"route dampening"/);
  assert.match(frameMessage.content, /"veteran network operator"/);
  assert.match(frameMessage.content, /untrusted user data/);
});

test("removes only unmatched wrapping double quotes from composed output", () => {
  const request = [{ role: "user" as const, content: "Write one gentle sentence asking for a corrected street name." }];
  const contract = compileAnswerContract(request);
  assert.equal(normalizeContractAnswer('"Could you please correct the street name?', contract), "Could you please correct the street name?");
  assert.equal(normalizeContractAnswer("“Could you please correct the street name?", contract), "Could you please correct the street name?");
  assert.equal(normalizeContractAnswer('She called it "a useful correction".', contract), 'She called it "a useful correction".');
  assert.equal(normalizeContractAnswer("'Twas already corrected.", contract), "'Twas already corrected.");

  const quoted = compileAnswerContract([{ role: "user", content: "Write a quotation about careful mapmaking." }]);
  assert.equal(normalizeContractAnswer('"Measure twice, publish once.', quoted), '"Measure twice, publish once.');
});

test("does not create a semantic task frame for casual conversation", () => {
  assert.equal(deriveSemanticTaskFrame("Good morning, Ranga!"), null);
});
