import assert from "node:assert/strict";
import test from "node:test";
import { answerDeterministicConversationRequest, answerUnavailableExternalAction, buildConversationMemoryQuery, buildConversationMessages, buildConversationMessagesWithSelected, trimConversationHistory } from "../lib/conversation-orchestration.ts";
import type { LocalMemory } from "../lib/memories.ts";

const memory = (id: string, content: string, kind: LocalMemory["kind"] = "preference"): LocalMemory => ({
  id, content, kind, origin: "user-approved", confidence: 1,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
});

test("contextual follow-ups include recent user topic for memory retrieval", () => {
  const query = buildConversationMemoryQuery([
    { role: "user", content: "Help me prepare a Python tutorial" },
    { role: "assistant", content: "What level?" },
    { role: "user", content: "Make it shorter" },
  ]);
  assert.match(query, /Python tutorial/);
  assert.match(query, /Make it shorter/);
});

test("orchestration selects relevant memory but excludes unrelated personal facts", () => {
  const result = buildConversationMessages(
    [{ role: "user", content: "Give me a Python example using a dataframe" }],
    [memory("1", "Use step-by-step Python examples"), memory("2", "My favorite city is Kyoto", "fact")],
  );
  assert.equal(result.memories.length, 1);
  assert.match(result.messages[1].content, /step-by-step Python/);
  assert.doesNotMatch(result.messages[1].content, /Kyoto/);
});

test("current-turn precedence is explicit in the model contract", () => {
  const result = buildConversationMessages(
    [{ role: "user", content: "For this answer, use paragraphs and no bullets" }],
    [memory("1", "Always answer with bullet points", "instruction")],
  );
  assert.match(result.messages[0].content, /latest user message.*override/i);
  assert.equal(result.memories.length, 0);
  assert.match(result.messages[1].content, /no bullet/i);
});

test("history trimming retains the newest complete turn without an orphan assistant", () => {
  const result = trimConversationHistory([
    { role: "user", content: "old".repeat(20) },
    { role: "assistant", content: "middle" },
    { role: "user", content: "latest" },
  ], 20);
  assert.deepEqual(result.map((item) => item.content), ["latest"]);
});

test("unavailable email execution is answered deterministically", () => {
  const answer = answerUnavailableExternalAction("Send an email to Priya saying the meeting is cancelled");
  assert.match(answer ?? "", /can't send/i);
  assert.match(answer ?? "", /draft/i);
  assert.equal(answerUnavailableExternalAction("Explain how email delivery works"), null);
});

test("exact literal constraints bypass probabilistic generation", () => {
  assert.equal(answerDeterministicConversationRequest([{ role: "user", content: "Reply with exactly one word: ready." }]), "ready");
});

test("applies the same core precedence contract to transformed scholar prompts", () => {
  const source = [{ role: "user" as const, content: "Explain joins in at most 40 words." }];
  const transformed = [{ role: "system" as const, content: "Teacher instructions" }, { role: "user" as const, content: "QUESTION and retrieved passages" }];
  const result = buildConversationMessagesWithSelected(transformed, [], source);
  assert.match(result.messages[0].content, /local-first personal assistant/i);
  assert.match(result.messages[1].content, /at most 40 words/i);
  assert.equal(result.messages.at(-1)?.content, "QUESTION and retrieved passages");
});

test("makes contextual follow-up focus explicit for smaller models", () => {
  const result = buildConversationMessages([
    { role: "user", content: "We chose PostgreSQL for the application database." },
    { role: "assistant", content: "Understood." },
    { role: "user", content: "Give one backup recommendation for it." },
  ]);
  assert.match(result.messages[1].content, /PostgreSQL/);
  assert.match(result.messages[1].content, /backup recommendation/);
  assert.equal(result.messages.at(-1)?.content, "Give one backup recommendation for PostgreSQL.");
});
