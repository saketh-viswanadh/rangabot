import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopArtifactFile } from "../lib/desktop-artifact-identity.ts";
import { reconcileCopiedDesktopResources } from "../lib/desktop-staged-resource-integrity.ts";

const hash = (byte: string) => byte.repeat(64);

const staged: DesktopArtifactFile[] = [
  { path: "DEPENDENCY_NOTICES.md", bytes: 19, sha256: hash("1") },
  { path: "node_modules/next/package.json", bytes: 23, sha256: hash("2") },
  { path: "runtime/ollama/ollama", bytes: 29, sha256: hash("3") },
];

const copied: DesktopArtifactFile[] = [
  { path: "app.asar", bytes: 31, sha256: hash("4") },
  ...staged.map((file) => ({ ...file, path: `rangabot-resources/${file.path}` })),
];

test("finalizer accepts an exact Forge copy while excluding outer-only resources", () => {
  assert.deepEqual(reconcileCopiedDesktopResources(staged, [...copied].reverse()), staged);
});

test("finalizer rejects every post-prepare copied-resource mutation before rebinding", () => {
  const adversaries: DesktopArtifactFile[][] = [
    copied.filter((file) => !file.path.endsWith("DEPENDENCY_NOTICES.md")),
    [...copied, { path: "rangabot-resources/unexpected.js", bytes: 1, sha256: hash("5") }],
    copied.map((file) => file.path.endsWith("package.json") ? { ...file, path: "rangabot-resources/package-renamed.json" } : file),
    copied.map((file) => file.path.endsWith("package.json") ? { ...file, path: `rangabot-resource/${file.path}` } : file),
    copied.map((file) => file.path.endsWith("DEPENDENCY_NOTICES.md") ? { ...file, bytes: file.bytes + 1 } : file),
    copied.map((file) => file.path.endsWith("runtime/ollama/ollama") ? { ...file, sha256: hash("6") } : file),
  ];
  for (const candidate of adversaries) {
    assert.throws(
      () => reconcileCopiedDesktopResources(staged, candidate),
      /do not exactly match the staged resource manifest/u,
    );
  }
  assert.equal(adversaries.length, 6);
});
