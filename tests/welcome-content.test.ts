import assert from "node:assert/strict";
import test from "node:test";
import {
  appendWelcomeHistory,
  chooseWelcomeIndex,
  parseWelcomeHistory,
  welcomeLineId,
  welcomeLines,
} from "../lib/welcome-content.ts";

test("keeps a varied, duplicate-free offline welcome collection", () => {
  assert.equal(welcomeLines.length, 300);
  for (const kind of ["QUOTE", "JOKE", "THOUGHT"] as const) {
    assert.equal(welcomeLines.filter((line) => line.kind === kind).length, 100);
  }
  assert.deepEqual(new Set(welcomeLines.map((line) => line.kind)), new Set(["QUOTE", "JOKE", "THOUGHT"]));
  assert.equal(new Set(welcomeLines.map((line) => line.id)).size, welcomeLines.length);
  assert.equal(new Set(welcomeLines.map((line) => line.text.toLowerCase())).size, welcomeLines.length);
  assert.ok(welcomeLines.every((line) => line.text.length <= 140));
});

test("avoids the current item and the recent 60-item welcome history", () => {
  const recent = welcomeLines.slice(1, 61).map((line) => line.id);
  const next = chooseWelcomeIndex(0, recent, () => 0);
  assert.ok(next > 60);
  assert.notEqual(welcomeLines[next].kind, welcomeLines[0].kind);
});

test("stores a bounded, valid welcome history", () => {
  const history = appendWelcomeHistory(Array.from({ length: 80 }, (_, index) => index), 250);
  assert.equal(history.length, 60);
  assert.equal(history.at(-1), welcomeLines[250].id);
  assert.deepEqual(parseWelcomeHistory(JSON.stringify([0, 299, -1, 300, 4.5, "2"])), [welcomeLines[0].id, welcomeLines[299].id]);
  assert.deepEqual(parseWelcomeHistory("not json"), []);
});

test("uses content-derived stable IDs and filters by the saved welcome mode", () => {
  const text = "The same line keeps its identity when a collection is reordered.";
  assert.equal(welcomeLineId("QUOTE", text), welcomeLineId("QUOTE", text));
  assert.notEqual(welcomeLineId("QUOTE", text), welcomeLineId("JOKE", text));
  assert.notEqual(welcomeLineId("QUOTE", text), welcomeLineId("QUOTE", `${text}!`));

  for (const [mode, kind] of [["quotes", "QUOTE"], ["jokes", "JOKE"], ["thoughts", "THOUGHT"]] as const) {
    const selected = chooseWelcomeIndex(-1, [], () => 0.5, mode);
    assert.equal(welcomeLines[selected].kind, kind);
  }
});

test("keeps category fallback bounded and migrates legacy numeric history safely", () => {
  const quoteIndices = welcomeLines.flatMap((line, index) => line.kind === "QUOTE" ? [index] : []);
  const blockedQuotes = quoteIndices.slice(0, -1).map((index) => welcomeLines[index].id);
  const selected = chooseWelcomeIndex(quoteIndices.at(-1)!, blockedQuotes, () => 0, "quotes");
  assert.equal(welcomeLines[selected].kind, "QUOTE");

  const legacy = parseWelcomeHistory(JSON.stringify([100, 100, 101]));
  assert.deepEqual(legacy, [welcomeLines[100].id, welcomeLines[101].id]);
  const booksFallback = chooseWelcomeIndex(-1, [], () => 0, "books");
  assert.ok(booksFallback >= 0 && booksFallback < welcomeLines.length);
});
