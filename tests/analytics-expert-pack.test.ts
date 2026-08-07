import assert from "node:assert/strict";
import test from "node:test";
import { issueAuthorizedAnalyticsRequest } from "../lib/analytics-pack-control.ts";
import { runAnalyticsExpertPack, type AnalyticsPackDependencies } from "../lib/analytics-expert-pack.ts";
import type { Conversation } from "../lib/conversations.ts";
import { ProviderError, type GenerationOptions } from "../lib/providers/types.ts";
import type { SqlExecutionResult } from "../lib/sql-runtime.ts";

const inputSha256 = "a".repeat(64);
const querySha256 = "b".repeat(64);

function conversation(question: string): Conversation {
  return {
    id: "conversation-a", title: "Analysis", messages: [{ role: "user", content: question }], projectId: null,
    datasetId: "dataset-a", pinned: false, createdAt: "2026-08-07T00:00:00.000Z", updatedAt: "2026-08-07T00:00:00.000Z",
  };
}

function request(question = "Show paid revenue by region") {
  const issued = issueAuthorizedAnalyticsRequest({
    conversation: conversation(question), conversationId: "conversation-a", datasetId: "dataset-a",
    submittedMessages: [{ role: "user", content: question }], requestId: "request-a",
  });
  assert.ok(issued);
  return issued;
}

function execution(): SqlExecutionResult {
  return {
    columns: ["region", "paid_revenue"],
    rows: [["North", "25"]],
    receipt: {
      engine: "duckdb", input: { filename: "shop.duckdb", sha256: inputSha256, sizeBytes: 128 }, querySha256,
      readOnly: true, externalAccess: false, rowLimit: 200, returnedRows: 1, truncated: false, durationMs: 12,
    },
  };
}

function dependencies(overrides: Partial<AnalyticsPackDependencies> = {}) {
  const state = { identityCalls: 0, schemaCalls: 0, jsonCalls: 0, textCalls: 0, sqlCalls: [] as Array<{ approvedDatasetPath: string; query: string; expectedInputSha256?: string; signal?: AbortSignal }>, jsonOptions: undefined as GenerationOptions | undefined, textOptions: undefined as GenerationOptions | undefined };
  const value: AnalyticsPackDependencies = {
    getDataset: () => ({ id: "dataset-a", name: "shop.duckdb", path: "/approved/shop.duckdb", format: "duckdb", sizeBytes: 128, addedAt: "2026-08-07T00:00:00.000Z" }),
    inspectIdentity: async () => { state.identityCalls += 1; return { canonical: "/approved/shop.duckdb", extension: ".duckdb", sizeBytes: 128, filename: "shop.duckdb", sha256: inputSha256 }; },
    inspectSchema: async () => { state.schemaCalls += 1; return [
      { table: "customers", name: "customer_id", type: "INTEGER" }, { table: "customers", name: "region", type: "VARCHAR" },
      { table: "orders", name: "order_id", type: "INTEGER" }, { table: "orders", name: "customer_id", type: "INTEGER" },
      { table: "payments", name: "order_id", type: "INTEGER" }, { table: "payments", name: "amount", type: "DOUBLE" },
      { table: "payments", name: "payment_status", type: "VARCHAR" },
    ]; },
    completeJson: async (_messages, options) => {
      state.jsonCalls += 1; state.jsonOptions = options;
      return JSON.stringify({ action: "query", source: "payments", aggregate: "sum", metric: "payments.amount", alias: "paid_revenue", dimensions: ["customers.region"], filters: [{ column: "payments.payment_status", operator: "eq", value: "paid" }], sort: [], limit: 0, decimals: 2, explanation: "Paid revenue by region." });
    },
    completeText: async (_messages, options) => { state.textCalls += 1; state.textOptions = options; return "North has verified paid revenue of 25."; },
    executeSql: async (input) => { state.sqlCalls.push(input); return execution(); },
    configuredModel: () => "llama3.2:3b",
    ...overrides,
  };
  return { value, state };
}

test("wraps the legacy analytical path with exact evidence, grants, model, and trace receipts", async () => {
  const fixture = dependencies();
  const outcome = await runAnalyticsExpertPack(request(), fixture.value);
  assert.equal(outcome.result.status, "success");
  assert.equal(outcome.result.responseProposal, "North has verified paid revenue of 25.");
  assert.deepEqual(outcome.result.warnings, []);
  assert.equal(fixture.state.identityCalls, 1);
  assert.equal(fixture.state.schemaCalls, 1);
  assert.equal(fixture.state.jsonCalls, 1);
  assert.equal(fixture.state.textCalls, 1);
  assert.equal(fixture.state.sqlCalls.length, 1);
  assert.equal(fixture.state.sqlCalls[0].expectedInputSha256, inputSha256);
  assert.equal(fixture.state.jsonOptions?.modelId, "llama3.2:3b");
  assert.equal(fixture.state.textOptions?.modelId, "llama3.2:3b");
  assert.deepEqual(outcome.result.receipt.permissionsUsed, ["approved-dataset:read", "local-runtime:execute"]);
  assert.deepEqual(outcome.result.receipt.grantIdsUsed, ["request-a:dataset", "request-a:runtime"]);
  assert.deepEqual(outcome.result.receipt.toolsUsed, ["duckdb-readonly"]);
  assert.equal(outcome.result.receipt.model?.resolvedModelId, "llama3.2:3b");
  assert.deepEqual(outcome.result.evidence[0]?.localExecution, {
    engine: "duckdb", resourceId: "dataset-a", inputSha256, querySha256, readOnly: true, externalAccess: false,
    rowLimit: 200, returnedRows: 1, truncated: false, durationMs: 12,
  });
  assert.deepEqual(outcome.trace, {
    engine: "duckdb", dataset: "shop.duckdb", query: fixture.state.sqlCalls[0].query, returnedRows: 1, truncated: false,
    durationMs: 12, inputSha256, querySha256, packId: "analytics", packVersion: "0.1.0", modelMode: "general", modelId: "llama3.2:3b",
  });
  assert.deepEqual(outcome.diagnostics?.execution, execution());
});

test("uses a deterministic verified fallback when narration fails without hiding the execution", async () => {
  const fixture = dependencies({ completeText: async () => { throw new ProviderError("unavailable", "offline"); } });
  const outcome = await runAnalyticsExpertPack(request(), fixture.value);
  assert.equal(outcome.result.status, "success");
  assert.match(outcome.result.responseProposal ?? "", /North/);
  assert.match(outcome.result.responseProposal ?? "", /25/);
  assert.equal(outcome.result.evidence.length, 1);
  assert.deepEqual(outcome.result.warnings, [{
    code: "model-narration-unavailable",
    message: "The model narration was unavailable, so Rangabot used a deterministic verified fallback.",
  }]);
  assert.ok(outcome.trace);
});

test("records when an ungrounded narration is rejected in favour of verified output", async () => {
  const fixture = dependencies({ completeText: async () => "North has revenue of 999999." });
  const outcome = await runAnalyticsExpertPack(request(), fixture.value);
  assert.equal(outcome.result.status, "success");
  assert.match(outcome.result.responseProposal ?? "", /25/);
  assert.deepEqual(outcome.result.warnings, [{
    code: "narration-grounding-rejected",
    message: "The model narration failed the result-grounding audit, so Rangabot used a deterministic verified fallback.",
  }]);
});

test("maps planning, schema, and cancellation failures into terminal typed outcomes", async () => {
  const planning = dependencies({ completeJson: async () => { throw new ProviderError("unavailable", "offline"); } });
  const planningOutcome = await runAnalyticsExpertPack(request(), planning.value);
  assert.equal(planningOutcome.result.error?.code, "provider-unavailable");
  assert.equal(planningOutcome.result.receipt.model?.resolvedModelId, "llama3.2:3b");

  const schema = dependencies({ inspectSchema: async () => { throw new Error("schema broke"); } });
  const schemaOutcome = await runAnalyticsExpertPack(request(), schema.value);
  assert.equal(schemaOutcome.result.error?.code, "tool-failure");
  assert.deepEqual(schemaOutcome.result.receipt.permissionsUsed, ["approved-dataset:read", "local-runtime:execute"]);

  const controller = new AbortController();
  const cancellation = dependencies({ completeText: async () => { controller.abort(); throw new ProviderError("cancelled", "stopped"); } });
  const cancelledOutcome = await runAnalyticsExpertPack(request(), cancellation.value, { signal: controller.signal });
  assert.equal(cancelledOutcome.result.status, "cancelled");
  assert.equal(cancelledOutcome.result.error?.code, "cancelled");
  assert.equal(cancelledOutcome.result.error?.retryable, false);
  assert.equal(cancelledOutcome.result.evidence.length, 0);
});

test("classifies structurally typed SQL failures across runtime boundaries", async () => {
  const fixture = dependencies({ executeSql: async () => { throw Object.assign(new Error("Provide one SQL query."), { code: "invalid-query" }); } });
  const outcome = await runAnalyticsExpertPack(request(), fixture.value);
  assert.equal(outcome.result.status, "failure");
  assert.equal(outcome.result.error?.code, "invalid-output");
  assert.equal(outcome.result.responseProposal, undefined);
});

test("fails closed before data or model access for invalid authority, revocation, and unqualified custom models", async () => {
  const invalid = request();
  invalid.grants[0] = { ...invalid.grants[0], resource: { kind: "dataset", id: "dataset-b" } };
  const invalidFixture = dependencies();
  const invalidOutcome = await runAnalyticsExpertPack(invalid, invalidFixture.value);
  assert.equal(invalidOutcome.result.error?.code, "invalid-output");
  assert.equal(invalidFixture.state.identityCalls, 0);
  assert.equal(invalidFixture.state.jsonCalls, 0);

  const revokedFixture = dependencies({ getDataset: () => null });
  const revokedOutcome = await runAnalyticsExpertPack(request(), revokedFixture.value);
  assert.equal(revokedOutcome.result.error?.code, "permission-required");
  assert.equal(revokedFixture.state.identityCalls, 0);

  const custom = request();
  custom.modelAssignment = { mode: "custom", modelId: "other:7b", requestOverride: true };
  const customFixture = dependencies();
  const customOutcome = await runAnalyticsExpertPack(custom, customFixture.value);
  assert.equal(customOutcome.result.error?.code, "model-unqualified");
  assert.equal(customFixture.state.identityCalls, 0);
});

test("stops before the first dependency when already cancelled", async () => {
  const controller = new AbortController();
  controller.abort();
  const fixture = dependencies();
  const outcome = await runAnalyticsExpertPack(request(), fixture.value, { signal: controller.signal });
  assert.equal(outcome.result.status, "cancelled");
  assert.equal(fixture.state.identityCalls, 0);
  assert.equal(fixture.state.schemaCalls, 0);
  assert.equal(fixture.state.jsonCalls, 0);
  assert.equal(fixture.state.sqlCalls.length, 0);
});

test("returns a clarification without running the final query", async () => {
  const fixture = dependencies({ completeJson: async () => JSON.stringify({ action: "clarify", source: "", aggregate: "", metric: "", alias: "", dimensions: [], filters: [], sort: [], limit: 0, decimals: 0, explanation: "Which measure should define that comparison?" }) });
  const outcome = await runAnalyticsExpertPack(request("Which region is best?"), fixture.value);
  assert.equal(outcome.result.status, "clarification");
  assert.equal(outcome.result.responseProposal, "Which measurable field should define that comparison?");
  assert.equal(outcome.trace, undefined);
  assert.equal(fixture.state.sqlCalls.length, 0);
});
