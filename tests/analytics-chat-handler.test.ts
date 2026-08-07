import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { handleAnalyticsChat, type AnalyticsChatDependencies } from "../lib/analytics-chat-handler.ts";
import { issueAuthorizedAnalyticsRequest } from "../lib/analytics-pack-control.ts";
import type { AnalyticsPackOutcome } from "../lib/analytics-expert-pack.ts";
import type { Conversation } from "../lib/conversations.ts";
import type { ExpertPackRequest, ExpertPackResult } from "../lib/expert-packs.ts";

const question = "Count the rows in the attached data";
const messages = [{ role: "user" as const, content: question }];
const sql = "SELECT COUNT(*) FROM dataset";
const querySha256 = createHash("sha256").update(sql).digest("hex");

function conversation(datasetId: string | null = "dataset-a"): Conversation {
  return {
    id: "conversation-a", title: "Analysis", messages, projectId: null, datasetId, pinned: false,
    createdAt: "2026-08-07T00:00:00.000Z", updatedAt: "2026-08-07T00:00:00.000Z",
  };
}

function successfulResult(request: ExpertPackRequest): ExpertPackResult {
  return {
    requestId: request.requestId, packId: request.packId, packVersion: request.packVersion, status: "success",
    responseProposal: "There are 2 verified rows.", warnings: [], modelBackgroundClaims: [],
    evidence: [{
      id: querySha256, kind: "table", source: "local-execution", locator: `duckdb:${"a".repeat(64)}:${querySha256}`, claims: ["Returned 2 verified rows."],
      localExecution: { engine: "duckdb", resourceId: "dataset-a", inputSha256: "a".repeat(64), querySha256, readOnly: true, externalAccess: false, rowLimit: 200, returnedRows: 2, truncated: false, durationMs: 10 },
    }],
    receipt: {
      permissionsUsed: ["approved-dataset:read", "local-runtime:execute"], grantIdsUsed: [`${request.requestId}:dataset`, `${request.requestId}:runtime`], toolsUsed: ["duckdb-readonly"], modelSwitches: 0,
      model: { requested: request.modelAssignment, resolvedModelId: "local:3b", compatibility: "experimental", qualificationSuiteId: "analytics-pack", reason: "Synthetic test model." },
    },
  };
}

function dependencies(overrides: Partial<AnalyticsChatDependencies> = {}) {
  const state = { issued: 0, ran: 0 };
  const value: AnalyticsChatDependencies = {
    getConversation: () => conversation(),
    issueRequest: (input) => { state.issued += 1; return issueAuthorizedAnalyticsRequest({ ...input, requestId: "request-a" }); },
    runPack: async (request) => {
      state.ran += 1;
      return {
        result: successfulResult(request),
        trace: { engine: "duckdb", dataset: "sample.duckdb", query: sql, returnedRows: 2, truncated: false, durationMs: 10, inputSha256: "a".repeat(64), querySha256, packId: "analytics", packVersion: "0.1.0", modelMode: "general", modelId: "local:3b" },
      };
    },
    ...overrides,
  };
  return { value, state };
}

test("does not select Analytics for ordinary conversation", async () => {
  const fixture = dependencies();
  const response = await handleAnalyticsChat({ messages: [{ role: "user", content: "Tell me a joke" }], datasetId: "dataset-a", conversationId: "conversation-a" }, fixture.value);
  assert.equal(response, null);
  assert.equal(fixture.state.issued, 0);
  assert.equal(fixture.state.ran, 0);
});

test("fails closed unless the current saved conversation owns the exact dataset", async () => {
  const fixture = dependencies({ getConversation: () => conversation("dataset-b") });
  const missingConversation = await handleAnalyticsChat({ messages, datasetId: "dataset-a" }, fixture.value);
  assert.equal(missingConversation?.status, 400);
  const wrongBinding = await handleAnalyticsChat({ messages, datasetId: "dataset-a", conversationId: "conversation-a" }, fixture.value);
  assert.equal(wrongBinding?.status, 400);
  assert.equal(fixture.state.ran, 0);
});

test("maps typed failures and cancellation without losing stable error codes", async () => {
  const fixture = dependencies({ runPack: async (request) => ({
    result: {
      requestId: request.requestId, packId: request.packId, packVersion: request.packVersion, status: "cancelled",
      evidence: [], modelBackgroundClaims: [], warnings: [], error: { code: "cancelled", message: "Stopped.", retryable: false },
      receipt: { permissionsUsed: [], grantIdsUsed: [], toolsUsed: [], modelSwitches: 0 },
    },
  }) });
  const response = await handleAnalyticsChat({ messages, datasetId: "dataset-a", conversationId: "conversation-a" }, fixture.value);
  assert.equal(response?.status, 499);
  assert.deepEqual(await response?.json(), { error: "Stopped.", code: "cancelled" });
});

test("propagates the validated response, trace, and typed fallback disposition", async () => {
  const fixture = dependencies({ runPack: async (request) => {
    const result = successfulResult(request);
    result.warnings = [{ code: "narration-grounding-rejected", message: "Fallback used." }];
    return {
      result,
      trace: { engine: "duckdb", dataset: "sample.duckdb", query: sql, returnedRows: 2, truncated: false, durationMs: 10, inputSha256: "a".repeat(64), querySha256, packId: "analytics", packVersion: "0.1.0", modelMode: "general", modelId: "local:3b" },
    } satisfies AnalyticsPackOutcome;
  } });
  const response = await handleAnalyticsChat({ messages, datasetId: "dataset-a", conversationId: "conversation-a" }, fixture.value);
  assert.equal(response?.status, 200);
  assert.equal(await response?.text(), "There are 2 verified rows.");
  assert.equal(response?.headers.get("X-Rangabot-Pack-Warnings"), "narration-grounding-rejected");
  const trace = JSON.parse(decodeURIComponent(response?.headers.get("X-Rangabot-Analysis") ?? ""));
  assert.equal(trace.packId, "analytics");
  assert.equal(trace.modelId, "local:3b");
});

test("fails closed instead of emitting a trace inconsistent with verified evidence", async () => {
  const fixture = dependencies({ runPack: async (request) => ({
    result: successfulResult(request),
    trace: { engine: "duckdb", dataset: "sample.duckdb", query: sql, returnedRows: 1, truncated: false, durationMs: 10, inputSha256: "a".repeat(64), querySha256, packId: "analytics", packVersion: "0.1.0", modelMode: "general", modelId: "local:3b" },
  }) });
  const response = await handleAnalyticsChat({ messages, datasetId: "dataset-a", conversationId: "conversation-a" }, fixture.value);
  assert.equal(response?.status, 500);
  assert.deepEqual(await response?.json(), { error: "The Analytics Pack returned inconsistent execution provenance.", code: "invalid-output" });
  assert.equal(response?.headers.get("X-Rangabot-Analysis"), null);
});
