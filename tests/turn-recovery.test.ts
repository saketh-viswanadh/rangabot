import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import test from "node:test";
import { conversationTurnRequestHash, type ConversationTurn } from "../lib/conversation-turns.ts";
import { codePreviewSha256 } from "../lib/repository-search.ts";
import { prepareTurnRecovery, TurnRecoveryPreparationError, type TurnRecoveryDependencies } from "../lib/turn-recovery-server.ts";
import { parseTurnRecoveryDraft, shouldRetainRecoveryBindingAfterStartFailure, turnRecoveryPlan, verifyTurnRecoveryDraftHash } from "../lib/turn-recovery.ts";

const conversationId = "11111111-1111-4111-8111-111111111111";
const turnId = "22222222-2222-4222-8222-222222222222";
const datasetId = "33333333-3333-4333-8333-333333333333";
const repositoryId = "44444444-4444-4444-8444-444444444444";
const projectId = "55555555-5555-4555-8555-555555555555";

function fixture() {
  let previewCalls = 0;
  let datasetInspections = 0;
  const preview = { path: "src/index.ts", startLine: 1, focusLine: 1, lines: ["export function ready() {", "  return true;"] };
  const previewSha256 = codePreviewSha256(preview);
  const userMessage = {
    role: "user" as const,
    content: "Compare this local function with the approved dataset.",
    replyTo: { role: "assistant" as const, excerpt: "The earlier design used a batch." },
    codeContext: { repository: "Approved repo", path: "src/index.ts", startLine: 1, endLine: 2 },
  };
  const options = {
    mode: "smart" as const,
    codeContext: { repositoryId, path: "src/index.ts", line: 1, previewSha256 },
    datasetId,
    datasetSha256: "a".repeat(64),
    projectId,
  };
  const turn: ConversationTurn = {
    id: turnId,
    conversationId,
    sequence: 1,
    status: "failed",
    requestHash: conversationTurnRequestHash(userMessage, options),
    userMessage,
    options,
    assistantMessage: { role: "assistant", content: "Unverified partial output that must never be reused." },
    failureCode: "timeout",
    failureMessage: "The local model timed out.",
    contextMessageCount: 0,
    executionStartedAt: "2026-08-24T00:00:00.000Z",
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:01:00.000Z",
    finishedAt: "2026-08-24T00:01:00.000Z",
  };
  const dependencies: TurnRecoveryDependencies = {
    turn: () => turn,
    conversation: () => ({ id: conversationId, title: "Recovery", projectId, datasetId, pinned: false, createdAt: turn.createdAt, updatedAt: turn.updatedAt, messages: [] }),
    dataset: () => ({ id: datasetId, name: "approved.csv", path: "/approved.csv", format: "csv", sizeBytes: 10, addedAt: turn.createdAt, approvalVersion: 2, fileIdentity: { device: "1", inode: "2", sizeBytes: 10, modifiedNs: "3", changedNs: "4", sha256: "a".repeat(64) } }),
    inspectDataset: async () => { datasetInspections += 1; },
    repository: () => ({ id: repositoryId, name: "Approved repo", path: "/repo", addedAt: turn.createdAt, approvalVersion: 2, rootIdentity: { device: "1", inode: "2" } }),
    preview: () => { previewCalls += 1; return preview; },
  };
  return { turn, dependencies, previewCalls: () => previewCalls, datasetInspections: () => datasetInspections, previewSha256 };
}

test("maps every governed terminal failure to an explicit, non-automatic recovery", () => {
  const codes = [
    "unavailable", "model-missing", "busy", "timeout", "cancelled", "http", "empty-output", "invalid-stream", "resource-limit",
    "capability-unavailable", "invalid-output", "model-unqualified", "permission-required", "provider-failure", "provider-unavailable", "tool-failure",
    "invalid-request", "internal", "interrupted",
  ];
  for (const code of codes) {
    const plan = turnRecoveryPlan(code === "cancelled" ? "cancelled" : "failed", code);
    assert.match(plan.guidance, /No complete answer was saved|did not finish|local run exceeded|local capability was not available/i, code);
    assert.ok(plan.primaryAction === "restore-request" || plan.primaryAction === "open-models", code);
  }
  assert.equal(turnRecoveryPlan("failed", "model-missing").primaryAction, "open-models");
  assert.equal(turnRecoveryPlan("failed", "resource-limit").title, "Try a smaller next step");
  assert.equal(turnRecoveryPlan("cancelled").title, "Stopped safely");
});

test("does not retain a recovery binding after a deterministic start rejection", () => {
  assert.equal(shouldRetainRecoveryBindingAfterStartFailure(), true);
  assert.equal(shouldRetainRecoveryBindingAfterStartFailure("internal"), true);
  for (const code of ["conflict", "invalid", "not-found", "turn-in-progress", "integrity", "stale-profile"]) {
    assert.equal(shouldRetainRecoveryBindingAfterStartFailure(code), false, code);
  }
});

test("reconstructs the exact goal and bindings without failed partial output", async () => {
  const { dependencies, previewCalls, datasetInspections, previewSha256 } = fixture();
  const recovery = await prepareTurnRecovery(turnId, conversationId, dependencies);
  assert.deepEqual(recovery.message, {
    role: "user",
    content: "Compare this local function with the approved dataset.",
    replyTo: { role: "assistant", excerpt: "The earlier design used a batch." },
    codeContext: { repository: "Approved repo", path: "src/index.ts", startLine: 1, endLine: 2 },
  });
  assert.equal(recovery.mode, "smart");
  assert.deepEqual(recovery.binding, { conversationId, projectId, datasetId, datasetSha256: "a".repeat(64), contextMessageCount: 0 });
  assert.deepEqual(recovery.codeContext, {
    repositoryId,
    repositoryName: "Approved repo",
    path: "src/index.ts",
    line: 1,
    startLine: 1,
    endLine: 2,
    characterCount: 40,
    previewSha256,
  });
  assert.equal(previewCalls(), 1);
  assert.equal(datasetInspections(), 1);
  assert.equal("assistantMessage" in recovery, false);
  assert.ok(parseTurnRecoveryDraft(recovery));
  assert.equal(await verifyTurnRecoveryDraftHash(recovery), true);
});

test("fails before repository access when a binding or dataset approval changed", async () => {
  {
    const { dependencies, previewCalls } = fixture();
    dependencies.conversation = () => ({ id: conversationId, title: "Recovery", projectId: null, datasetId, pinned: false, createdAt: "", updatedAt: "", messages: [] });
    await assert.rejects(prepareTurnRecovery(turnId, conversationId, dependencies), (error: unknown) => error instanceof TurnRecoveryPreparationError && error.code === "binding-changed");
    assert.equal(previewCalls(), 0);
  }
  {
    const { dependencies, previewCalls } = fixture();
    dependencies.dataset = () => null;
    await assert.rejects(prepareTurnRecovery(turnId, conversationId, dependencies), (error: unknown) => error instanceof TurnRecoveryPreparationError && error.code === "resource-changed");
    assert.equal(previewCalls(), 0);
  }
  {
    const { dependencies, previewCalls } = fixture();
    const approved = dependencies.dataset(datasetId)!;
    dependencies.dataset = () => ({ ...approved, fileIdentity: { ...approved.fileIdentity, sha256: "b".repeat(64) } });
    await assert.rejects(prepareTurnRecovery(turnId, conversationId, dependencies), /same content/i);
    assert.equal(previewCalls(), 0);
  }
  {
    const { dependencies, previewCalls } = fixture();
    dependencies.inspectDataset = async () => { throw new Error("changed"); };
    await assert.rejects(prepareTurnRecovery(turnId, conversationId, dependencies), /dataset changed or is unavailable/i);
    assert.equal(previewCalls(), 0);
  }
});

test("rejects stale conversation history and mutations during recovery", async () => {
  {
    const { dependencies } = fixture();
    dependencies.conversation = () => ({
      id: conversationId, title: "Recovery", projectId, datasetId, pinned: false, createdAt: "", updatedAt: "",
      messages: [{ role: "user", content: "Newer context" }, { role: "assistant", content: "Newer answer" }],
    });
    await assert.rejects(prepareTurnRecovery(turnId, conversationId, dependencies), /chat continued/i);
  }
  {
    const { dependencies } = fixture();
    let reads = 0;
    const stable = dependencies.conversation;
    dependencies.conversation = (id) => {
      reads += 1;
      const value = stable(id);
      return reads === 1 ? value : value ? { ...value, projectId: null } : null;
    };
    await assert.rejects(prepareTurnRecovery(turnId, conversationId, dependencies), /changed while recovery/i);
  }
});

test("rejects a legacy terminal turn without an exact project receipt", async () => {
  const { dependencies, turn } = fixture();
  delete (turn.options as Partial<typeof turn.options>).projectId;
  turn.requestHash = conversationTurnRequestHash(turn.userMessage, turn.options);
  await assert.rejects(prepareTurnRecovery(turnId, conversationId, dependencies), /no exact project binding receipt/i);
});

test("rejects revoked, moved, or tampered code recovery instead of weakening context", async () => {
  {
    const { dependencies, previewCalls } = fixture();
    dependencies.repository = () => null;
    await assert.rejects(prepareTurnRecovery(turnId, conversationId, dependencies), /no longer approved/i);
    assert.equal(previewCalls(), 0);
  }
  {
    const { dependencies } = fixture();
    dependencies.preview = () => ({ path: "src/index.ts", startLine: 1, focusLine: 2, lines: ["changed"] });
    await assert.rejects(prepareTurnRecovery(turnId, conversationId, dependencies), /code excerpt changed/i);
  }
  {
    const { dependencies } = fixture();
    dependencies.preview = () => ({ path: "src/index.ts", startLine: 1, focusLine: 1, lines: ["maliciousChange();", "return false;"] });
    await assert.rejects(prepareTurnRecovery(turnId, conversationId, dependencies), /code excerpt changed/i);
  }
  {
    const { dependencies, turn } = fixture();
    turn.requestHash = "0".repeat(64);
    await assert.rejects(prepareTurnRecovery(turnId, conversationId, dependencies), (error: unknown) => error instanceof TurnRecoveryPreparationError && error.code === "integrity");
  }
});

test("accepts only the exact bounded recovery response shape", async () => {
  const { dependencies } = fixture();
  const recovery = await prepareTurnRecovery(turnId, conversationId, dependencies);
  assert.ok(parseTurnRecoveryDraft(recovery));
  assert.equal(parseTurnRecoveryDraft({ ...recovery, automaticRetry: true }), null);
  assert.equal(parseTurnRecoveryDraft({ ...recovery, requestHash: "0" }), null);
  assert.equal(parseTurnRecoveryDraft({ ...recovery, codeContext: { ...recovery.codeContext, path: "" } }), null);
  assert.equal(parseTurnRecoveryDraft({ ...recovery, codeContext: { ...recovery.codeContext, path: "src/other.ts" } }), null);
  assert.equal(parseTurnRecoveryDraft({ ...recovery, codeContext: { ...recovery.codeContext, line: 99 } }), null);
  assert.equal(parseTurnRecoveryDraft({ ...recovery, message: { ...recovery.message, role: "assistant" } }), null);
  assert.equal(await verifyTurnRecoveryDraftHash({ ...recovery, message: { ...recovery.message, content: "Changed goal" } }), false);
});

test("preserves a valid long reply excerpt across recovery", async () => {
  const { dependencies, turn } = fixture();
  const excerpt = "Earlier context ".repeat(20).slice(0, 240);
  turn.userMessage = { ...turn.userMessage, replyTo: { role: "assistant", excerpt } };
  turn.requestHash = conversationTurnRequestHash(turn.userMessage, turn.options);
  const recovery = await prepareTurnRecovery(turnId, conversationId, dependencies);
  assert.equal(recovery.message.replyTo?.excerpt, excerpt);
  assert.equal(recovery.message.replyTo?.excerpt.length, 240);
  assert.equal(await verifyTurnRecoveryDraftHash(recovery), true);
});

test("keeps recovery deterministic and outside successful-turn execution", () => {
  const started = performance.now();
  for (let index = 0; index < 100_000; index += 1) turnRecoveryPlan("failed", index % 2 ? "timeout" : "model-missing");
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 5_000, `planner took ${elapsed.toFixed(1)} ms`);

  const page = readFileSync("app/page.tsx", "utf8");
  const card = readFileSync("app/components/turn-recovery-card.tsx", "utf8");
  assert.match(page, /\/api\/conversation-turns\/\$\{turnId\}\/recovery/);
  assert.match(page, /Review the composer, then press Send/);
  assert.doesNotMatch(page, /copyTurnRequestText/);
  assert.match(card, /Nothing runs automatically/);
  assert.doesNotMatch(card, /onAction\([^)]*\)[\s\S]*submit|location\.reload/);
});
