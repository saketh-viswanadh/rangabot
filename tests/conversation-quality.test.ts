import assert from "node:assert/strict";
import test from "node:test";
import { compileAnswerContract } from "../lib/conversation-contract.ts";
import { reviewConversationAnswer, shouldReviewConversationAnswer } from "../lib/conversation-quality.ts";
import { ProviderError } from "../lib/providers/types.ts";

test("reviews substantive answers but leaves casual and deterministic formats alone", () => {
  const explain = [{ role: "user" as const, content: "Explain p-values simply." }];
  assert.equal(shouldReviewConversationAnswer(explain, compileAnswerContract(explain)), true);
  const casual = [{ role: "user" as const, content: "Hello Ranga!" }];
  assert.equal(shouldReviewConversationAnswer(casual, compileAnswerContract(casual)), false);
  const exact = [{ role: "user" as const, content: "Reply with exactly one word: ready." }];
  assert.equal(shouldReviewConversationAnswer(exact, compileAnswerContract(exact)), false);
});

test("accepts a sound draft without rewriting it", async () => {
  const messages = [{ role: "user" as const, content: "Explain why indexes help." }];
  const result = await reviewConversationAnswer({
    messages,
    contractMessages: messages,
    contract: compileAnswerContract(messages),
    draft: "Indexes reduce the rows a database must scan.",
    completeJson: async (_messages, options) => {
      assert.equal(options?.jsonSchema?.type, "object");
      return JSON.stringify({ verdict: "pass", issues: [], revisedAnswer: "Indexes reduce the rows a database must scan." });
    },
  });
  assert.equal(result.status, "passed");
  assert.match(result.answer, /reduce/);
});

test("accepts bounded schema variations from smaller local reviewers", async () => {
  const messages = [{ role: "user" as const, content: "Explain why indexes help." }];
  const result = await reviewConversationAnswer({
    messages, contractMessages: messages, contract: compileAnswerContract(messages), draft: "Wrong draft.",
    completeJson: async () => JSON.stringify({ status: "REVISE", issues: ["Incorrect"], revised_answer: "Indexes reduce the rows scanned." }),
  });
  assert.equal(result.status, "revised");
  assert.match(result.answer, /rows scanned/);
});

test("uses one corrected local revision and rejects malformed review output", async () => {
  const messages = [{ role: "user" as const, content: "Calculate 12 divided by 3." }];
  const contract = compileAnswerContract(messages);
  const revised = await reviewConversationAnswer({
    messages, contractMessages: messages, contract, draft: "12 / 3 = 5.",
    completeJson: async () => JSON.stringify({ verdict: "revise", issues: ["Arithmetic is wrong"], revisedAnswer: "12 / 3 = 4." }),
  });
  assert.equal(revised.status, "revised");
  assert.equal(revised.answer, "12 / 3 = 4.");
  const invalid = await reviewConversationAnswer({ messages, contractMessages: messages, contract, draft: "Original", completeJson: async () => "not json" });
  assert.equal(invalid.status, "invalid-review");
  assert.equal(invalid.answer, "Original");
});

test("rejects a revision that worsens explicit contract compliance", async () => {
  const messages = [{ role: "user" as const, content: "Explain indexes in at most 5 words." }];
  const contract = compileAnswerContract(messages);
  const result = await reviewConversationAnswer({
    messages, contractMessages: messages, contract, draft: "Indexes make lookups faster.",
    completeJson: async () => JSON.stringify({ verdict: "revise", issues: ["Add detail"], revisedAnswer: "Indexes make database lookups much faster by avoiding full table scans." }),
  });
  assert.equal(result.status, "rejected-revision");
  assert.equal(result.answer, "Indexes make lookups faster.");
});

test("surfaces a reviewer response resource limit instead of hiding or retrying it", async () => {
  let calls = 0;
  const messages = [{ role: "user" as const, content: "Explain this result." }];
  const contract = compileAnswerContract(messages);
  await assert.rejects(reviewConversationAnswer({
    messages,
    contractMessages: messages,
    contract,
    draft: "A bounded draft.",
    force: true,
    completeJson: async () => {
      calls += 1;
      throw new ProviderError("resource-limit", "The local model response exceeded the safe output limit.");
    },
  }), (error: unknown) => error instanceof ProviderError && error.code === "resource-limit");
  assert.equal(calls, 1);
});
