import assert from "node:assert/strict";
import test from "node:test";
import { welcomeLines } from "../lib/welcome-content.ts";

test("keeps a varied, duplicate-free offline welcome collection", () => {
  assert.ok(welcomeLines.length >= 24);
  assert.deepEqual(new Set(welcomeLines.map((line) => line.kind)), new Set(["QUOTE", "JOKE", "THOUGHT"]));
  assert.equal(new Set(welcomeLines.map((line) => line.text.toLowerCase())).size, welcomeLines.length);
  assert.ok(welcomeLines.every((line) => line.text.length <= 140));
});
