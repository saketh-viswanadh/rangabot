import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const masteryPage = readFileSync("app/mastery/page.tsx", "utf8");
const masteryStyles = readFileSync("app/mastery/mastery.css", "utf8");
const masterySource: { epics: Array<{ id: string }> } = JSON.parse(readFileSync("content/path-to-mastery.json", "utf8"));

test("keeps the mastery roadmap focused on capability evidence rather than a runtime marketing banner", () => {
  assert.doesNotMatch(masteryPage, /masteryBanner|mastery-banner/);
  assert.doesNotMatch(masteryStyles, /\.mastery-banner/);
});

test("maps every mastery branch icon by stable branch identity", () => {
  assert.match(masteryPage, /Record<string, CraftIconName>/);
  assert.match(masteryPage, /branchIcons\[branch\.id\]/);
  for (const epic of masterySource.epics) assert.match(masteryPage, new RegExp(`\\b${epic.id}:`));
});

test("supports an accessible keyboard lifecycle for mastery details", () => {
  assert.match(masteryPage, /event\.key === "Escape"/);
  assert.match(masteryPage, /event\.key !== "Tab"/);
  assert.match(masteryPage, /closeButtonRef\.current\?\.focus\(\)/);
  assert.match(masteryPage, /returnTarget\?\.focus\(\)/);
  assert.match(masteryPage, /aria-describedby="selected-mastery-description"/);
  assert.match(masteryStyles, /\.mastery-close:focus-visible/);
});

test("keeps the compact mastery summary in normal flow on narrow screens", () => {
  assert.match(masteryStyles, /@media \(max-width: 900px\)[\s\S]*?\.mastery-summary \{ position: static; text-align: left; \}/);
});
