import assert from "node:assert/strict";
import test from "node:test";
import { formatCodeContext, isCodeContextRequest } from "../lib/code-context.ts";

test("validates explicit code context references", () => {
  assert.equal(isCodeContextRequest({ repositoryId: "repo-1", path: "src/math.ts", line: 12 }), true);
  assert.equal(isCodeContextRequest({ repositoryId: "repo-1", path: "src/math.ts", line: 12, previewSha256: "a".repeat(64) }), true);
  assert.equal(isCodeContextRequest({ repositoryId: "repo-1", path: "", line: 12 }), false);
  assert.equal(isCodeContextRequest({ repositoryId: "repo-1", path: "src/math.ts", line: 0 }), false);
  assert.equal(isCodeContextRequest({ repositoryId: "repo-1", path: "src/math.ts", line: 12, previewSha256: "A".repeat(64) }), false);
  assert.equal(isCodeContextRequest({ repositoryId: "repo-1", path: "src/math.ts", line: 12, extra: true }), false);
});

test("formats only the bounded preview with line numbers", () => {
  const text = formatCodeContext(
    { id: "repo-1", name: "rangabot", path: "/tmp/rangabot", addedAt: new Date(0).toISOString() },
    { path: "src/math.ts", startLine: 10, focusLine: 11, lines: ["const a = 1;", "return a;"] },
  );
  assert.match(text, /Repository: rangabot/);
  assert.match(text, /File: src\/math\.ts/);
  assert.match(text, /Lines: 10-11/);
  assert.match(text, /10: const a = 1;/);
  assert.match(text, /11: return a;/);
});
