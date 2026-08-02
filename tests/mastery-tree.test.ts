import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { materializeMasteryTree, masteryProgress, validateMasteryTree, type MasteryEvidenceRegistry } from "../lib/mastery-tree.ts";
import { normalizeLineEndings } from "../lib/text-normalization.ts";
import { validateMasteryContributors } from "../lib/mastery-contributors.ts";
import { hasMasteryApproval, requiresMasteryApproval } from "../lib/mastery-governance.ts";

const source: unknown = JSON.parse(readFileSync(resolve("content/path-to-mastery.json"), "utf8"));
const evidence: unknown = JSON.parse(readFileSync(resolve("content/mastery-evidence.json"), "utf8"));
const contributors: unknown = JSON.parse(readFileSync(resolve("content/mastery-contributors.json"), "utf8"));
validateMasteryTree(source, evidence);
const tree = materializeMasteryTree(source);

test("derives a complete program map from criterion-level evidence", () => {
  const progress = masteryProgress(tree);
  assert.equal(tree.epics.length, 9);
  assert.equal(progress.total, 45);
  assert.equal(progress.criteriaTotal, 146);
  assert.ok(tree.epics.some((epic) => epic.id === "platform"));
  assert.ok(progress.percent > 0 && progress.percent < 100);
  const hasManualField = (value: unknown, field: string): boolean => Boolean(value && typeof value === "object" && (Object.prototype.hasOwnProperty.call(value, field) || Object.values(value).some((item) => hasManualField(item, field))));
  assert.equal(hasManualField(source, "score"), false);
  assert.equal(hasManualField(source, "status"), false);
  for (const node of tree.epics.flatMap((epic) => epic.nodes)) assert.ok(node.criteria.length >= 3);
});

test("does not call a capability unlocked when any criterion is below verified", () => {
  for (const node of tree.epics.flatMap((epic) => epic.nodes)) {
    if (node.status === "unlocked") assert.ok(node.criteria.every((criterion) => criterion.state === "verified"));
  }
  assert.equal(tree.epics.flatMap((epic) => epic.nodes).find((node) => node.id === "local-conversation")?.status, "regressed");
});

test("keeps web research dependent on a persistent allowlist", () => {
  const nodes = tree.epics.flatMap((epic) => epic.nodes);
  const research = nodes.find((node) => node.id === "web-research");
  assert.equal(research?.status, "locked");
  assert.ok(research?.dependencies.includes("web-allowlist"));
  assert.match(research?.criteria.map((criterion) => criterion.text).join(" ") ?? "", /approved query leaves device/i);
});

test("requires attributable merged evidence for every official achievement", () => {
  validateMasteryContributors(contributors, tree, evidence as MasteryEvidenceRegistry);
  const founder = contributors.contributors.find((contributor) => contributor.github === "saketh-viswanadh");
  assert.equal(founder?.role, "Founder and lead maintainer");
  assert.equal(founder?.claims.length, 29);
  assert.ok(founder?.claims.some((claim) => claim.nodeId === "mastery-tree" && claim.evidence.includes("pr-52")));
  assert.ok(founder?.claims.some((claim) => claim.nodeId === "platform" ) === false);
});

test("treats Windows and Unix line endings as equivalent", () => {
  const unix = "# Path to Mastery\n\nGenerated locally.\n";
  assert.equal(normalizeLineEndings(unix.replaceAll("\n", "\r\n")), normalizeLineEndings(unix));
});

test("locks every canonical mastery artifact behind owner approval", () => {
  assert.equal(requiresMasteryApproval(["app/page.tsx"]), false);
  for (const file of ["content/mastery-contributors.json", "content/mastery-evidence.json", "content\\path-to-mastery.json", "docs/PATH_TO_MASTERY.md"]) assert.equal(requiresMasteryApproval([file]), true);
  assert.equal(hasMasteryApproval(["documentation", "mastery-approved"]), true);
});
