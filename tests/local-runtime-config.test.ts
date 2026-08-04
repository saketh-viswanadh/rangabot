import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CHAT_CONTEXT_TOKENS, DEFAULT_CHAT_MODEL, DEFAULT_KNOWLEDGE_BUDGET_BYTES, getConfiguredChatModel, getConfiguredContextTokens, getKnowledgeBudgetBytes, getLocalOllamaBaseUrl } from "../lib/local-runtime-config.ts";

test("uses the lightweight documented chat model by default", () => {
  assert.equal(getConfiguredChatModel(""), DEFAULT_CHAT_MODEL);
  assert.equal(DEFAULT_CHAT_MODEL, "llama3.2:3b");
});

test("uses a bounded, reproducible local context size", () => {
  assert.equal(DEFAULT_CHAT_CONTEXT_TOKENS, 4096);
  assert.equal(getConfiguredContextTokens(""), 4096);
  assert.equal(getConfiguredContextTokens("8192"), 8192);
  assert.throws(() => getConfiguredContextTokens("511"), /between 512 and 131072/);
  assert.throws(() => getConfiguredContextTokens("not-a-number"), /between 512 and 131072/);
});

test("validates the configurable local knowledge budget", () => {
  assert.equal(getKnowledgeBudgetBytes(""), DEFAULT_KNOWLEDGE_BUDGET_BYTES);
  assert.equal(getKnowledgeBudgetBytes("1048576"), 1048576);
  assert.throws(() => getKnowledgeBudgetBytes("not-a-number"), /positive integer/);
  assert.throws(() => getKnowledgeBudgetBytes("-1"), /positive integer/);
});

test("accepts loopback Ollama URLs and rejects remote or credentialed URLs", () => {
  assert.equal(getLocalOllamaBaseUrl("http://127.0.0.1:11434"), "http://127.0.0.1:11434");
  assert.equal(getLocalOllamaBaseUrl("http://localhost:11434/"), "http://localhost:11434");
  assert.throws(() => getLocalOllamaBaseUrl("https://example.com"), /only permits a loopback/);
  assert.throws(() => getLocalOllamaBaseUrl("http://user:pass@127.0.0.1:11434"), /only permits a loopback/);
});
