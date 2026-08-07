import assert from "node:assert/strict";
import test from "node:test";
import { expertPackFailureStatus } from "../lib/expert-pack-http.ts";
import { expertPackFailureCodes } from "../lib/expert-packs.ts";

test("preserves stable HTTP recovery semantics for typed pack failures", () => {
  assert.equal(expertPackFailureStatus("cancelled"), 499);
  assert.equal(expertPackFailureStatus("timeout"), 504);
  assert.equal(expertPackFailureStatus("model-missing"), 503);
  assert.equal(expertPackFailureStatus("provider-unavailable"), 503);
  assert.equal(expertPackFailureStatus("provider-failure"), 502);
  assert.equal(expertPackFailureStatus("tool-failure"), 502);
  assert.equal(expertPackFailureStatus("permission-required"), 400);
  assert.equal(expertPackFailureStatus(undefined), 500);
  assert.equal(expertPackFailureCodes.every((code) => Number.isInteger(expertPackFailureStatus(code))), true);
});
