import assert from "node:assert/strict";
import test from "node:test";
import { dispatchCoreChat, type CoreChatDispatchDependencies } from "../lib/chat-core-dispatch.ts";

const messages = [{ role: "user" as const, content: "Count the attached rows" }];

function dependencies(overrides: Partial<CoreChatDispatchDependencies> = {}) {
  const calls: string[] = [];
  const value: CoreChatDispatchDependencies = {
    deterministic: () => { calls.push("deterministic"); return null; },
    directMemory: () => { calls.push("memory"); return null; },
    memoryTitles: () => { calls.push("memory-titles"); return []; },
    getRepository: () => { calls.push("repository"); return { id: "repo-a", name: "Repo", path: "/approved/repo", addedAt: "2026-08-07T00:00:00.000Z" }; },
    preview: () => { calls.push("preview"); return { path: "src/index.ts", startLine: 1, focusLine: 1, lines: ["export {};"] }; },
    formatContext: () => { calls.push("format"); return "APPROVED CODE"; },
    analytics: async () => { calls.push("analytics"); return new Response("analysed"); },
    ...overrides,
  };
  return { value, calls };
}

test("deterministic answers outrank memory, local files, and Analytics", async () => {
  const fixture = dependencies({ deterministic: () => { fixture.calls.push("deterministic"); return "ready"; } });
  const result = await dispatchCoreChat({ messages, codeContext: { repositoryId: "repo-a", path: "src/index.ts", line: 1 }, datasetId: "dataset-a", conversationId: "conversation-a" }, fixture.value);
  assert.equal(await result.response?.text(), "ready");
  assert.deepEqual(fixture.calls, ["deterministic"]);
});

test("direct approved memory outranks local files and Analytics", async () => {
  const fixture = dependencies({ directMemory: () => { fixture.calls.push("memory"); return "Your name is Saketh."; } });
  const result = await dispatchCoreChat({ messages, codeContext: { repositoryId: "repo-a", path: "src/index.ts", line: 1 }, datasetId: "dataset-a", conversationId: "conversation-a" }, fixture.value);
  assert.equal(await result.response?.text(), "Your name is Saketh.");
  assert.deepEqual(fixture.calls, ["deterministic", "memory", "memory-titles"]);
});

test("code allowlist validation happens before Analytics", async () => {
  const fixture = dependencies({ getRepository: () => { fixture.calls.push("repository"); return null; } });
  const result = await dispatchCoreChat({ messages, codeContext: { repositoryId: "revoked", path: "src/index.ts", line: 1 }, datasetId: "dataset-a", conversationId: "conversation-a" }, fixture.value);
  assert.equal(result.response?.status, 400);
  assert.deepEqual(fixture.calls, ["deterministic", "memory", "repository"]);
});

test("Analytics receives control only after higher-precedence local context checks", async () => {
  const fixture = dependencies();
  const result = await dispatchCoreChat({ messages, codeContext: { repositoryId: "repo-a", path: "src/index.ts", line: 1 }, datasetId: "dataset-a", conversationId: "conversation-a" }, fixture.value);
  assert.equal(await result.response?.text(), "analysed");
  assert.equal(result.localCodeContext, "APPROVED CODE");
  assert.deepEqual(fixture.calls, ["deterministic", "memory", "repository", "preview", "format", "analytics"]);
});

test("ordinary conversation continues with any approved local code context", async () => {
  const fixture = dependencies({ analytics: async () => { fixture.calls.push("analytics"); return null; } });
  const result = await dispatchCoreChat({ messages: [{ role: "user", content: "Explain this function" }], codeContext: { repositoryId: "repo-a", path: "src/index.ts", line: 1 } }, fixture.value);
  assert.equal(result.response, null);
  assert.equal(result.localCodeContext, "APPROVED CODE");
  assert.deepEqual(fixture.calls, ["deterministic", "memory", "repository", "preview", "format", "analytics"]);
});
