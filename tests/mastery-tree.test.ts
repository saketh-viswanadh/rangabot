import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { masteryProgress, validateMasteryTree } from "../lib/mastery-tree.ts";
import { normalizeLineEndings } from "../lib/text-normalization.ts";

const tree: unknown = JSON.parse(readFileSync(resolve("content/path-to-mastery.json"), "utf8"));
const contributorRegistry = JSON.parse(readFileSync(resolve("content/mastery-contributors.json"), "utf8")) as {
  policy: string;
  contributors: Array<{ github: string; avatar: string | null }>;
};

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
  assert.match(contributorRegistry.policy, /opt-in/i);
  assert.ok(contributorRegistry.contributors.length > 0);
  for (const contributor of contributorRegistry.contributors) {
    assert.match(contributor.github, /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i);
    assert.ok(contributor.avatar === null || contributor.avatar.startsWith("/mastery/contributors/"));
  }
});

test("treats Windows and Unix line endings as the same generated mastery document", () => {
  const unix = "# Path to Mastery\n\nGenerated locally.\n";
  const windows = unix.replaceAll("\n", "\r\n");
  assert.equal(normalizeLineEndings(windows), normalizeLineEndings(unix));
});
