import assert from "node:assert/strict";
import test from "node:test";
import { artifactQualityGates, artifactSkills, nextArtifactSkill } from "../lib/artifact-skills.ts";

test("keeps artifact abilities ordered and independently identifiable", () => {
  assert.equal(new Set(artifactSkills.map((skill) => skill.id)).size, artifactSkills.length);
  assert.equal(artifactSkills.filter((skill) => skill.status === "available").map((skill) => skill.id).includes("word"), true);
  assert.equal(artifactSkills.filter((skill) => skill.status === "next").length <= 1, true);
  assert.equal(nextArtifactSkill(), null);
  for (const skill of artifactSkills) {
    assert.equal(skill.dependsOn.every((dependency) => artifactSkills.some((candidate) => candidate.id === dependency)), true);
  }
});

test("requires the shared gold-standard artifact gates", () => {
  assert.deepEqual(artifactQualityGates, [
    "structured-brief",
    "content-completeness",
    "deterministic-render",
    "format-validation",
    "visual-review",
    "user-preview",
  ]);
});
