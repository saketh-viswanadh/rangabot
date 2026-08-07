import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PALETTE,
  normalizeStoredPalette,
  paletteOptions,
  parseAppearance,
  parsePalette,
} from "../lib/appearance-preferences.ts";

test("keeps one canonical ordered palette registry", () => {
  assert.deepEqual(
    paletteOptions.map(({ id }) => id),
    ["rangabot", "monochrome", "graphite", "cement", "moss", "harbor", "plum", "ember"],
  );
  assert.equal(new Set(paletteOptions.map(({ id }) => id)).size, paletteOptions.length);
  assert.equal(DEFAULT_PALETTE, "rangabot");
});

test("accepts every current palette and safely defaults unknown values", () => {
  for (const { id } of paletteOptions) assert.equal(parsePalette(id), id);
  assert.equal(parsePalette(null), DEFAULT_PALETTE);
  assert.equal(parsePalette("unknown"), DEFAULT_PALETTE);
});

test("preserves and rewrites every historical palette preference", () => {
  assert.equal(parsePalette("sand"), "rangabot");
  assert.equal(parsePalette("sage"), "moss");
  assert.equal(parsePalette("lavender"), "plum");

  assert.deepEqual(normalizeStoredPalette("sand"), {
    palette: "rangabot",
    shouldPersist: true,
  });
  assert.deepEqual(normalizeStoredPalette("cement"), {
    palette: "cement",
    shouldPersist: false,
  });
  assert.deepEqual(normalizeStoredPalette("unknown"), {
    palette: DEFAULT_PALETTE,
    shouldPersist: true,
  });
});

test("accepts only explicit light and dark appearance preferences", () => {
  assert.equal(parseAppearance("light"), "light");
  assert.equal(parseAppearance("dark"), "dark");
  assert.equal(parseAppearance("system"), null);
  assert.equal(parseAppearance(null), null);
});
