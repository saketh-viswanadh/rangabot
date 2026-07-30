import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { masteryProgress, validateMasteryTree } from "../lib/mastery-tree.ts";
import { normalizeLineEndings } from "../lib/text-normalization.ts";
import { validateMasteryContributors } from "../lib/mastery-contributors.ts";
import { hasMasteryApproval, requiresMasteryApproval } from "../lib/mastery-governance.ts";

const tree: unknown = JSON.parse(readFileSync(resolve("content/path-to-mastery.json"), "utf8"));
const contributorRegistry: unknown = JSON.parse(readFileSync(resolve("content/mastery-contributors.json"), "utf8"));

test("keeps the public mastery tree complete, scored, and dependency-safe", () => {
  validateMasteryTree(tree);
  const progress = masteryProgress(tree);
  assert.equal(tree.branches.length, 8);
  assert.equal(progress.total, 40);
  assert.ok(progress.unlocked > 0);
  assert.ok(progress.active > 0);
  assert.ok(progress.percent > 0 && progress.percent < 100);
});

test("keeps web research locked behind the approved persistent allowlist", () => {
  validateMasteryTree(tree);
  const nodes = tree.branches.flatMap((branch) => branch.nodes);
  const allowlist = nodes.find((node) => node.id === "web-allowlist");
  const research = nodes.find((node) => node.id === "web-research");
  assert.equal(allowlist?.status, "ready");
  assert.equal(research?.status, "locked");
  assert.ok(research?.dependencies.includes("web-allowlist"));
  assert.match(research?.acceptance.join(" ") ?? "", /approved query leaves device/i);
});

test("keeps mastery recognition opt-in and prevents runtime GitHub avatar tracking", () => {
  validateMasteryTree(tree);
  validateMasteryContributors(contributorRegistry, tree);
  assert.match(contributorRegistry.policy, /opt-in/i);
  assert.match(contributorRegistry.policy, /CODEOWNER/);
  assert.ok(contributorRegistry.contributors.length > 0);
  for (const contributor of contributorRegistry.contributors) {
    assert.match(contributor.github, /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i);
    assert.ok(contributor.avatar === null || contributor.avatar.startsWith("/mastery/contributors/"));
  }
});

test("records the founder's implemented mastery achievements with merged evidence", () => {
  validateMasteryTree(tree);
  validateMasteryContributors(contributorRegistry, tree);
  const founder = contributorRegistry.contributors.find((contributor) => contributor.github === "saketh-viswanadh");
  assert.equal(founder?.role, "Founder and lead maintainer");
  assert.ok((founder?.claims.length ?? 0) >= 19);
  assert.ok(founder?.claims.every((claim) => claim.evidence.length > 0));
  assert.ok(founder?.claims.some((claim) => claim.nodeId === "mastery-tree" && claim.evidence.some((item) => item.reference === "#52")));
});

test("treats Windows and Unix line endings as the same generated mastery document", () => {
  const unix = "# Path to Mastery\n\nGenerated locally.\n";
  const windows = unix.replaceAll("\n", "\r\n");
  assert.equal(normalizeLineEndings(windows), normalizeLineEndings(unix));
});

test("locks official mastery data behind the owner-controlled approval label", () => {
  assert.equal(requiresMasteryApproval(["app/page.tsx"]), false);
  assert.equal(requiresMasteryApproval(["content/mastery-contributors.json"]), true);
  assert.equal(requiresMasteryApproval(["content\\path-to-mastery.json"]), true);
  assert.equal(hasMasteryApproval(["documentation", "mastery-approved"]), true);
  assert.equal(hasMasteryApproval(["mastery-claim"]), false);
});
