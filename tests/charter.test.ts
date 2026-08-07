import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const charter = JSON.parse(readFileSync("content/rangabot-charter.json", "utf8")) as {
  version: number;
  vision: string[];
  mission: string[];
  tagline: string;
  promise: string;
  decisionTest: string;
  principles: Array<{ id: string; title: string }>;
  identity: Array<{ id: string; title: string }>;
};
const mastery = JSON.parse(readFileSync("content/path-to-mastery.json", "utf8")) as {
  epics: Array<{ id: string; name: string }>;
};

test("keeps one complete governed Rangabot charter", () => {
  assert.equal(charter.version, 1);
  assert.equal(charter.vision.length, 2);
  assert.equal(charter.mission.length, 2);
  assert.equal(charter.principles.length, 12);
  assert.equal(charter.identity.length, 10);
  assert.match(charter.tagline, /Your machine\. Your models\. Their full potential\./);
  assert.match(charter.promise, /Stay mine\./);
  assert.match(charter.decisionTest, /ordinary hardware/i);
  assert.equal(new Set(charter.principles.map((item) => item.id)).size, charter.principles.length);
});

test("translates the charter into the complete mastery program", () => {
  const epicIds = new Set(mastery.epics.map((epic) => epic.id));
  for (const required of ["mind", "scholar", "analyst", "builder", "creator", "companion", "steward", "guardian", "platform"]) assert.ok(epicIds.has(required));
  assert.deepEqual(mastery.epics.map((epic) => epic.name), ["Mind & Memory", "Scholar", "Analyst", "Builder", "Creator", "Personal Companion", "Model Steward", "Guardian", "Open Platform"]);
});
