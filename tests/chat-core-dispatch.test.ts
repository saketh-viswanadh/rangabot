import assert from "node:assert/strict";
import test from "node:test";
import { dispatchCoreChat, type CoreChatDispatchDependencies } from "../lib/chat-core-dispatch.ts";

const messages = [{ role: "user" as const, content: "Count the attached rows" }];

function dependencies(overrides: Partial<CoreChatDispatchDependencies> = {}) {
  const calls: string[] = [];
  const value: CoreChatDispatchDependencies = {
    safeContinuation: () => null,
    deterministic: () => null,
    classifyDirectMemory: () => null,
    approvedMemoryAllowed: () => true,
    executeDirectMemory: () => { calls.push("execute-memory"); return { answer: "Your name is Saketh.", titles: ["Preferred name"] }; },
    getRepository: () => { calls.push("repository"); return { id: "repo-a", name: "Repo", path: "/approved/repo", addedAt: "2026-08-07T00:00:00.000Z" }; },
    preview: () => { calls.push("preview"); return { path: "src/index.ts", startLine: 1, focusLine: 1, lines: ["export {};"] }; },
    formatContext: () => { calls.push("format"); return "APPROVED CODE"; },
    analytics: async () => { calls.push("analytics"); return new Response("analysed"); },
    wordRequested: () => false,
    analysisIntent: () => ({ requested: true, requiresDataset: true, explicitlyDeclined: false }),
    vaultRequested: () => false,
    vaultPreference: () => "unspecified",
    repositoryPreference: () => "unspecified",
    ...overrides,
  };
  return { value, calls };
}

test("safe continuation outranks generation and performs no stateful capability work", async () => {
  const fixture = dependencies({ safeContinuation: () => "Nothing was sent. Here is a draft." });
  const result = await dispatchCoreChat({ messages, datasetId: "dataset-a" }, fixture.value);
  assert.equal(await result.response?.text(), "Nothing was sent. Here is a draft.");
  assert.equal(result.capabilityPlan.route, "safe-continuation");
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(result.usedContexts, []);
  assert.deepEqual(result.attemptedContexts, []);
});

test("deterministic answers perform no stateful capability work", async () => {
  const fixture = dependencies({ deterministic: () => "ready" });
  const result = await dispatchCoreChat({ messages, codeContext: { repositoryId: "repo-a", path: "src/index.ts", line: 1 }, datasetId: "dataset-a" }, fixture.value);
  assert.equal(await result.response?.text(), "ready");
  assert.equal(result.capabilityPlan.route, "deterministic-answer");
  assert.deepEqual(fixture.calls, []);
});

test("deterministic arithmetic carries an exact finish receipt without model or resource work", async () => {
  const fixture = dependencies({
    deterministic: () => "The verified result is 25.",
    analysisIntent: () => ({ requested: false, requiresDataset: false, explicitlyDeclined: false }),
  });
  const result = await dispatchCoreChat({ messages: [{ role: "user", content: "Calculate 10% of 250" }] }, fixture.value);
  assert.equal(await result.response?.text(), "The verified result is 25.");
  assert.deepEqual(JSON.parse(decodeURIComponent(result.response?.headers.get("X-Rangabot-Finish") ?? "")), {
    version: "finish-v1",
    status: "passed",
    checks: ["completion", "arithmetic"],
    issueCount: 0,
  });
  assert.deepEqual(fixture.calls, []);
});

test("direct memory is classified without storage and executed exactly once after selection", async () => {
  const fixture = dependencies({ classifyDirectMemory: () => "preferred-name" });
  const result = await dispatchCoreChat({ messages, codeContext: { repositoryId: "repo-a", path: "src/index.ts", line: 1 }, datasetId: "dataset-a" }, fixture.value);
  assert.equal(await result.response?.text(), "Your name is Saketh.");
  assert.equal(result.capabilityPlan.route, "direct-memory");
  assert.deepEqual(fixture.calls, ["execute-memory"]);
  assert.deepEqual(result.usedContexts, ["approved-memory"]);
  assert.deepEqual(result.attemptedContexts, ["approved-memory"]);
});

test("current-turn memory opt-out blocks direct and opportunistic memory access", async () => {
  const fixture = dependencies({
    classifyDirectMemory: () => "preferred-name",
    approvedMemoryAllowed: () => false,
    analysisIntent: () => ({ requested: false, requiresDataset: false, explicitlyDeclined: false }),
  });
  const result = await dispatchCoreChat({ messages: [{ role: "user", content: "Do not use saved memory; explain recursion." }] }, fixture.value);
  assert.equal(result.capabilityPlan.route, "conversation");
  assert.equal(result.approvedMemoryAllowed, false);
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(result.usedContexts, []);
  assert.deepEqual(result.attemptedContexts, []);
});

test("revoked code is validated for a code request before model work", async () => {
  const fixture = dependencies({
    analysisIntent: () => ({ requested: false, requiresDataset: false, explicitlyDeclined: false }),
    repositoryPreference: () => "use",
    getRepository: () => { fixture.calls.push("repository"); return null; },
  });
  const result = await dispatchCoreChat({ messages: [{ role: "user", content: "Explain this code" }], codeContext: { repositoryId: "revoked", path: "src/index.ts", line: 1 } }, fixture.value);
  assert.equal(result.response?.status, 400);
  assert.deepEqual(fixture.calls, ["repository"]);
  assert.deepEqual(result.usedContexts, []);
  assert.deepEqual(result.attemptedContexts, ["repository"]);
});

test("changed code bytes fail before the excerpt is formatted or used", async () => {
  const fixture = dependencies({
    analysisIntent: () => ({ requested: false, requiresDataset: false, explicitlyDeclined: false }),
    repositoryPreference: () => "use",
  });
  const result = await dispatchCoreChat({
    messages: [{ role: "user", content: "Explain this code" }],
    codeContext: { repositoryId: "repo-a", path: "src/index.ts", line: 1, previewSha256: "0".repeat(64) },
  }, fixture.value);
  assert.equal(result.response?.status, 409);
  assert.match(await result.response?.text() ?? "", /code excerpt changed/i);
  assert.deepEqual(fixture.calls, ["repository", "preview"]);
  assert.deepEqual(result.usedContexts, []);
  assert.deepEqual(result.attemptedContexts, ["repository"]);
});

test("Analytics ignores an incidental code attachment and records only used data", async () => {
  const fixture = dependencies();
  const result = await dispatchCoreChat({ messages, codeContext: { repositoryId: "repo-a", path: "src/index.ts", line: 1 }, datasetId: "dataset-a" }, fixture.value);
  assert.equal(await result.response?.text(), "analysed");
  assert.equal(result.capabilityPlan.route, "analytics");
  assert.equal(result.localCodeContext, null);
  assert.deepEqual(fixture.calls, ["analytics"]);
  assert.deepEqual(result.usedContexts, ["dataset"]);
  assert.deepEqual(result.attemptedContexts, ["dataset"]);
});

test("Analytics distinguishes attempted access from completed use on failures", async () => {
  const rejected = dependencies({ analytics: async () => { rejected.calls.push("analytics"); return Response.json({ error: "revoked" }, { status: 400 }); } });
  const rejectedResult = await dispatchCoreChat({ messages, datasetId: "dataset-a" }, rejected.value);
  assert.equal(rejectedResult.response?.status, 400);
  assert.deepEqual(rejectedResult.usedContexts, []);
  assert.deepEqual(rejectedResult.attemptedContexts, ["dataset"]);

  const failed = dependencies({ analytics: async () => { failed.calls.push("analytics"); throw new Error("analysis failed"); } });
  await assert.rejects(
    dispatchCoreChat({ messages, datasetId: "dataset-a" }, failed.value),
    (error: unknown) => {
      assert.equal((error as { name?: string }).name, "CapabilityExecutionError");
      assert.deepEqual((error as { usedContexts?: string[] }).usedContexts, []);
      assert.deepEqual((error as { attemptedContexts?: string[] }).attemptedContexts, ["dataset"]);
      return true;
    },
  );
});

test("an explicit analysis and code conflict clarifies before either resource is opened", async () => {
  const fixture = dependencies({ repositoryPreference: () => "use" });
  const result = await dispatchCoreChat({ messages: [{ role: "user", content: "Compare this code with the attached data" }], codeContext: { repositoryId: "repo-a", path: "src/index.ts", line: 1 }, datasetId: "dataset-a" }, fixture.value);
  assert.equal(result.capabilityPlan.route, "clarification");
  assert.match(await result.response?.text() ?? "", /No attached resource has been opened/i);
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(result.usedContexts, []);
});

test("a missing explicitly requested dataset clarifies without touching storage", async () => {
  const fixture = dependencies();
  const result = await dispatchCoreChat({ messages }, fixture.value);
  assert.equal(result.capabilityPlan.route, "clarification");
  assert.match(await result.response?.text() ?? "", /approved dataset/i);
  assert.deepEqual(fixture.calls, []);
});

test("current-request negation selects code and suppresses attached-data analysis", async () => {
  const fixture = dependencies({
    analysisIntent: () => ({ requested: false, requiresDataset: false, explicitlyDeclined: true }),
    repositoryPreference: () => "use",
  });
  const result = await dispatchCoreChat({ messages: [{ role: "user", content: "Explain this code; do not analyze the attached dataset" }], codeContext: { repositoryId: "repo-a", path: "src/index.ts", line: 1 }, datasetId: "dataset-a" }, fixture.value);
  assert.equal(result.capabilityPlan.route, "repository-context");
  assert.equal(result.localCodeContext, "APPROVED CODE");
  assert.deepEqual(fixture.calls, ["repository", "preview", "format"]);
  assert.deepEqual(result.usedContexts, ["repository"]);
});

test("Word selection retains only an explicitly requested approved code excerpt", async () => {
  const fixture = dependencies({
    wordRequested: () => true,
    analysisIntent: () => ({ requested: false, requiresDataset: false, explicitlyDeclined: false }),
    repositoryPreference: () => "use",
  });
  const result = await dispatchCoreChat({ messages: [{ role: "user", content: "Create a Word document explaining this code" }], codeContext: { repositoryId: "repo-a", path: "src/index.ts", line: 1 } }, fixture.value);
  assert.equal(result.response, null);
  assert.equal(result.capabilityPlan.route, "word-document");
  assert.equal(result.localCodeContext, "APPROVED CODE");
  assert.deepEqual(fixture.calls, ["repository", "preview", "format"]);
});

test("explicit Local-mode Vault intent is selected without opening the Vault during planning", async () => {
  const fixture = dependencies({
    analysisIntent: () => ({ requested: false, requiresDataset: false, explicitlyDeclined: false }),
    vaultRequested: () => true,
    vaultPreference: () => "use",
  });
  const result = await dispatchCoreChat({ messages: [{ role: "user", content: "What do my local books say?" }] }, fixture.value);
  assert.equal(result.capabilityPlan.route, "knowledge-vault");
  assert.equal(result.response, null);
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(result.usedContexts, []);
});

test("disabled cloud handoff returns an inspectable local answer and invokes nothing", async () => {
  const fixture = dependencies();
  const result = await dispatchCoreChat({ messages, mode: "codex", codeContext: { repositoryId: "repo-a", path: "src/index.ts", line: 1 }, datasetId: "dataset-a" }, fixture.value);
  assert.equal(result.response?.status, 200);
  assert.match(await result.response?.text() ?? "", /Nothing was sent to the cloud/i);
  assert.equal(result.capabilityPlan.route, "unavailable");
  assert.deepEqual(fixture.calls, []);
});
