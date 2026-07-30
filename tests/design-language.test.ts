import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mainPage = readFileSync("app/page.tsx", "utf8");
const masteryPage = readFileSync("app/mastery/page.tsx", "utf8");
const iconSource = readFileSync("app/components/craft-icon.tsx", "utf8");

test("uses the shared crafted icon system instead of platform-dependent glyphs", () => {
  const bannedGlyphs = /[＋✦◇◆‹›↗→⌘✉▤↩■↑×✎▱▰⌂◈☀☾]/u;
  assert.doesNotMatch(mainPage, bannedGlyphs);
  assert.doesNotMatch(masteryPage, bannedGlyphs);
  assert.match(mainPage, /CraftIcon/);
  assert.match(masteryPage, /CraftIcon/);
});

test("keeps crafted icons local, scalable and presentation-only", () => {
  assert.match(iconSource, /viewBox="0 0 20 20"/);
  assert.match(iconSource, /aria-hidden="true"/);
  assert.doesNotMatch(iconSource, /https?:\/\//);
});
