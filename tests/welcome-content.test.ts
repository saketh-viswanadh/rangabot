import assert from "node:assert/strict";
import test from "node:test";
import {
  appendWelcomeHistory,
  chooseWelcomeIndex,
  parseWelcomeHistory,
  welcomeLines,
} from "../lib/welcome-content.ts";

test("keeps a varied, duplicate-free offline welcome collection", () => {
  assert.equal(welcomeLines.length, 300);
  for (const kind of ["QUOTE", "JOKE", "THOUGHT"] as const) {
    assert.equal(welcomeLines.filter((line) => line.kind === kind).length, 100);
  }
  assert.deepEqual(new Set(welcomeLines.map((line) => line.kind)), new Set(["QUOTE", "JOKE", "THOUGHT"]));
  assert.equal(new Set(welcomeLines.map((line) => line.text.toLowerCase())).size, welcomeLines.length);
  assert.ok(welcomeLines.every((line) => line.text.length <= 140));
});

test("avoids the current item and the recent 60-item welcome history", () => {
  const recent = Array.from({ length: 60 }, (_, index) => index + 1);
  const next = chooseWelcomeIndex(0, recent, () => 0);
  assert.ok(next > 60);
  assert.notEqual(welcomeLines[next].kind, welcomeLines[0].kind);
});

test("stores a bounded, valid welcome history", () => {
  const history = appendWelcomeHistory(Array.from({ length: 80 }, (_, index) => index), 250);
  assert.equal(history.length, 60);
  assert.equal(history.at(-1), 250);
  assert.deepEqual(parseWelcomeHistory(JSON.stringify([0, 299, -1, 300, 4.5, "2"])), [0, 299]);
  assert.deepEqual(parseWelcomeHistory("not json"), []);
});
