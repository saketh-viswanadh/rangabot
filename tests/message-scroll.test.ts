import assert from "node:assert/strict";
import test from "node:test";
import { isNearMessageBottom } from "../lib/message-scroll.ts";

test("follows messages while the reader is near the bottom", () => {
  assert.equal(isNearMessageBottom(920, 500, 1_500), true);
  assert.equal(isNearMessageBottom(1_000, 500, 1_500), true);
});

test("stops following after the reader scrolls away from the bottom", () => {
  assert.equal(isNearMessageBottom(700, 500, 1_500), false);
});

test("supports an explicit bottom-follow threshold", () => {
  assert.equal(isNearMessageBottom(890, 500, 1_500, 100), false);
  assert.equal(isNearMessageBottom(900, 500, 1_500, 100), true);
});
