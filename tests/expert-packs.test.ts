import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPERT_PACK_SCHEMA_VERSION,
  type ExpertPackManifest,
  type ExpertPackRequest,
  type ExpertPackResult,
  validateExpertPackManifest,
  validateExpertPackModelAssignment,
  validateExpertPackRequest,
  validateExpertPackResult,
} from "../lib/expert-packs.ts";

const analyticsManifest = (): ExpertPackManifest => ({
  schemaVersion: EXPERT_PACK_SCHEMA_VERSION,
  id: "analytics",
  name: "Analytics",
  version: "1.0.0",
  summary: "Analyse explicitly approved local data with bounded execution and evidence receipts.",
  maturity: "design",
  capabilities: ["sql-analysis", "result-interpretation"],
  permissions: ["approved-dataset:read", "local-runtime:execute"],
  tools: [{ id: "duckdb-readonly", required: true, execution: "deterministic", network: "disabled" }],
  modelPolicy: {
    selectionModes: ["automatic", "general", "custom"],
    defaultMode: "automatic",
    allowRequestOverride: true,
    minimumContextTokens: 4096,
    requiresStructuredOutput: true,
    requiresToolCalling: false,
  },
  resources: {
    downloadSizeMb: 0,
    workingMemoryMb: 256,
    maxConcurrentGenerativeModels: 1,
    unloadAfterSeconds: 300,
  },
  qualification: {
    suiteId: "analytics-pack",
    suiteVersion: "1.0.0",
    minimumOverallPassRate: 0.9,
    minimumCategoryPassRate: 0.8,
    requiredCriticalPassRate: 1,
    criticalRepetitions: 3,
  },
  uninstall: {
    preserveUserDataByDefault: true,
    removableArtifacts: ["derived-cache", "qualification-results"],
  },
});

function validRequest(): ExpertPackRequest {
  return {
    requestId: "request-a", conversationId: "conversation-a", packId: "analytics", packVersion: "1.0.0", capability: "sql-analysis",
    currentRequest: "Count the approved rows", conversation: [{ role: "user", content: "Count the approved rows" }],
    grants: [
      { id: "dataset-grant", permission: "approved-dataset:read", scope: { kind: "conversation", id: "conversation-a" }, resource: { kind: "dataset", id: "dataset-a" } },
      { id: "runtime-grant", permission: "local-runtime:execute", scope: { kind: "request", id: "request-a" } },
    ],
    modelAssignment: { mode: "general", requestOverride: false },
    contextReferences: [{ id: "dataset-a", kind: "dataset", title: "Approved data" }],
  };
}

function validResult(): ExpertPackResult {
  return {
    requestId: "request-a", packId: "analytics", packVersion: "1.0.0", status: "success", responseProposal: "There are 2 rows.",
    evidence: [{
      id: "query-evidence", kind: "table", source: "local-execution", locator: `duckdb:${"a".repeat(64)}:${"b".repeat(64)}`, claims: ["Returned 2 verified rows."],
      localExecution: { engine: "duckdb", resourceId: "dataset-a", inputSha256: "a".repeat(64), querySha256: "b".repeat(64), readOnly: true, externalAccess: false, rowLimit: 200, returnedRows: 2, truncated: false, durationMs: 12 },
    }],
    modelBackgroundClaims: [],
    warnings: [],
    receipt: {
      permissionsUsed: ["approved-dataset:read", "local-runtime:execute"], grantIdsUsed: ["dataset-grant", "runtime-grant"], toolsUsed: ["duckdb-readonly"], modelSwitches: 0,
      model: { requested: { mode: "general", requestOverride: false }, resolvedModelId: "local:3b", compatibility: "experimental", qualificationSuiteId: "analytics-pack", reason: "Verified only for this experimental pack." },
    },
  };
}

test("accepts a model-independent Expert Pack v1 manifest", () => {
  assert.deepEqual(validateExpertPackManifest(analyticsManifest()), { valid: true, errors: [] });
});

test("requires all three per-pack model choices", () => {
  const manifest = analyticsManifest();
  manifest.modelPolicy.selectionModes = ["automatic", "general"];
  const result = validateExpertPackManifest(manifest);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /automatic, general and custom/);
});

test("rejects undeclared permissions, hidden web access and parallel generative models", () => {
  const manifest = analyticsManifest() as unknown as Record<string, unknown>;
  manifest.permissions = ["arbitrary-filesystem:write"];
  manifest.tools = [{ id: "web-fetch", required: true, execution: "model-assisted", network: "approved-only" }];
  manifest.resources = { downloadSizeMb: 0, workingMemoryMb: 256, maxConcurrentGenerativeModels: 2, unloadAfterSeconds: 300 };
  const result = validateExpertPackManifest(manifest);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /unknown scope/);
  assert.match(result.errors.join("\n"), /requires approved-web:read/);
  assert.match(result.errors.join("\n"), /must be 1 in v1/);
});

test("requires a perfect critical gate and privacy-preserving uninstall", () => {
  const manifest = analyticsManifest() as unknown as Record<string, unknown>;
  manifest.qualification = { suiteId: "analytics-pack", suiteVersion: "1.0.0", minimumOverallPassRate: 0.9, minimumCategoryPassRate: 0.8, requiredCriticalPassRate: 0.95, criticalRepetitions: 3 };
  manifest.uninstall = { preserveUserDataByDefault: false, removableArtifacts: [] };
  const result = validateExpertPackManifest(manifest);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /requiredCriticalPassRate must be 1/);
  assert.match(result.errors.join("\n"), /preserveUserDataByDefault must be true/);
});

test("custom model assignment is explicit and request overrides are inspectable", () => {
  assert.equal(validateExpertPackModelAssignment({ mode: "custom", modelId: "local-model:7b", requestOverride: true }).valid, true);
  assert.equal(validateExpertPackModelAssignment({ mode: "custom", requestOverride: true }).valid, false);
  assert.equal(validateExpertPackModelAssignment({ mode: "general", modelId: "hidden-switch", requestOverride: false }).valid, false);
});

test("rejects unknown manifest fields instead of silently expanding authority", () => {
  const manifest = { ...analyticsManifest(), remoteEndpoint: "https://example.com" };
  const result = validateExpertPackManifest(manifest);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /remoteEndpoint is not allowed/);
});

test("validates exact request-scoped and conversation-scoped pack authority", () => {
  const manifest = analyticsManifest();
  assert.deepEqual(validateExpertPackRequest(validRequest(), manifest), { valid: true, errors: [] });

  const wrongDataset = validRequest();
  wrongDataset.grants[0] = { ...wrongDataset.grants[0], resource: { kind: "dataset", id: "dataset-b" } };
  assert.match(validateExpertPackRequest(wrongDataset, manifest).errors.join("\n"), /no matching context reference/);

  const replayed = validRequest();
  replayed.grants[0] = { ...replayed.grants[0], scope: { kind: "conversation", id: "conversation-b" } };
  assert.match(validateExpertPackRequest(replayed, manifest).errors.join("\n"), /not bound/);

  const widenedRuntime = validRequest();
  widenedRuntime.grants[1] = { ...widenedRuntime.grants[1], scope: { kind: "request", id: "request-b" } };
  assert.match(validateExpertPackRequest(widenedRuntime, manifest).errors.join("\n"), /not bound/);
});

test("rejects forged result permissions, grants, tools, resources, and model receipts", () => {
  const manifest = analyticsManifest();
  const request = validRequest();
  assert.deepEqual(validateExpertPackResult(validResult(), manifest, request), { valid: true, errors: [] });

  const forgedTool = validResult();
  forgedTool.receipt.toolsUsed = ["shell"];
  assert.match(validateExpertPackResult(forgedTool, manifest, request).errors.join("\n"), /undeclared/);

  const missingDatasetGrant = validResult();
  missingDatasetGrant.receipt.grantIdsUsed = ["runtime-grant"];
  assert.match(validateExpertPackResult(missingDatasetGrant, manifest, request).errors.join("\n"), /permission has no matching used grant/);

  const wrongResource = validResult();
  wrongResource.evidence[0].localExecution = { ...wrongResource.evidence[0].localExecution!, resourceId: "dataset-b" };
  assert.match(validateExpertPackResult(wrongResource, manifest, request).errors.join("\n"), /resource is not attached/);

  const forgedModel = validResult();
  forgedModel.receipt.model = { ...forgedModel.receipt.model!, requested: { mode: "custom", modelId: "hidden:70b", requestOverride: true } };
  assert.match(validateExpertPackResult(forgedModel, manifest, request).errors.join("\n"), /does not match/);
});

test("enforces mutually exclusive success, clarification, failure, and cancellation envelopes", () => {
  const manifest = analyticsManifest();
  const request = validRequest();
  const clarification: ExpertPackResult = { requestId: "request-a", packId: "analytics", packVersion: "1.0.0", status: "clarification", responseProposal: "Which metric?", clarification: "Which metric?", evidence: [], modelBackgroundClaims: [], warnings: [], receipt: { permissionsUsed: [], grantIdsUsed: [], toolsUsed: [], modelSwitches: 0 } };
  assert.equal(validateExpertPackResult(clarification, manifest, request).valid, true);
  const badCancellation: ExpertPackResult = { ...clarification, status: "failure", responseProposal: undefined, clarification: undefined, error: { code: "cancelled", message: "Stopped", retryable: true } };
  assert.equal(validateExpertPackResult(badCancellation, manifest, request).valid, false);
});

test("requires evidence for success and inspectable model use for background claims", () => {
  const manifest = analyticsManifest();
  const request = validRequest();
  const noEvidence = validResult();
  noEvidence.evidence = [];
  assert.match(validateExpertPackResult(noEvidence, manifest, request).errors.join("\n"), /requires at least one evidence/);

  const hiddenModel = validResult();
  hiddenModel.modelBackgroundClaims = ["This is uncited model background."];
  hiddenModel.receipt.model = undefined;
  assert.match(validateExpertPackResult(hiddenModel, manifest, request).errors.join("\n"), /require an inspectable model receipt/);

  const forgedWarning = validResult() as unknown as Record<string, unknown>;
  forgedWarning.warnings = [{ code: "silently-fixed", message: "Trust me." }];
  assert.match(validateExpertPackResult(forgedWarning, manifest, request).errors.join("\n"), /warnings\[0\] is invalid/);
});
