import assert from "node:assert/strict";
import test from "node:test";
import { getExpertPackManifest, listExpertPackManifests } from "../lib/expert-pack-registry.ts";
import { validateExpertPackManifest } from "../lib/expert-packs.ts";

test("loads one immutable, local-only Analytics reference manifest", () => {
  const manifests = listExpertPackManifests();
  assert.equal(manifests.length, 1);
  assert.equal(Object.isFrozen(manifests), true);
  const analytics = getExpertPackManifest("analytics");
  assert.ok(analytics);
  assert.deepEqual(validateExpertPackManifest(analytics), { valid: true, errors: [] });
  assert.equal(analytics.maturity, "experimental");
  assert.equal(Object.isFrozen(analytics), true);
  assert.equal(Object.isFrozen(analytics.tools), true);
  assert.deepEqual(analytics.tools, [{ id: "duckdb-readonly", required: true, execution: "deterministic", network: "disabled" }]);
  assert.equal(getExpertPackManifest("unknown"), null);
});

test("does not let registry consumers mutate installed authority", () => {
  const analytics = getExpertPackManifest("analytics");
  assert.ok(analytics);
  assert.throws(() => { (analytics.permissions as string[]).push("approved-web:read"); }, TypeError);
  assert.throws(() => { (listExpertPackManifests() as unknown[]).push({}); }, TypeError);
  assert.deepEqual(getExpertPackManifest("analytics")?.permissions, ["approved-dataset:read", "local-runtime:execute"]);
});
