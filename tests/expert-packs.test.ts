import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPERT_PACK_SCHEMA_VERSION,
  type ExpertPackManifest,
  validateExpertPackManifest,
  validateExpertPackModelAssignment,
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
