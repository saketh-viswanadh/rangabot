import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { previewRepositoryFile, searchRepository } from "../lib/repository-search.ts";

test("searches only bounded text files and returns line-aware previews", () => {
  const parent = mkdtempSync(join(tmpdir(), "rangabot-code-search-"));
  const root = join(parent, "repo");
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "src", "math.ts"), "export function total(values: number[]) {\n  return values.reduce((sum, value) => sum + value, 0);\n}\n");
    writeFileSync(join(root, ".env"), "SECRET_QUERY=values.reduce");
    writeFileSync(join(root, "node_modules", "ignored.js"), "values.reduce");
    writeFileSync(join(root, "binary.txt"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(parent, "outside.ts"), "values.reduce");
    const repository = { id: "repo", name: "repo", path: root, addedAt: new Date(0).toISOString() };
    assert.deepEqual(searchRepository(repository, "values.reduce"), [{
      path: join("src", "math.ts"),
      line: 2,
      excerpt: "return values.reduce((sum, value) => sum + value, 0);",
    }]);
    const preview = previewRepositoryFile(repository, join("src", "math.ts"), 2);
    assert.equal(preview.focusLine, 2);
    assert.equal(preview.lines[1], "  return values.reduce((sum, value) => sum + value, 0);");
    assert.throws(() => previewRepositoryFile(repository, "../outside.ts", 1), /outside the approved repository/);
    assert.throws(() => previewRepositoryFile(repository, ".env", 1), /cannot be previewed safely/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("requires a meaningful bounded search query", () => {
  const repository = { id: "missing", name: "missing", path: "/not/read", addedAt: new Date(0).toISOString() };
  assert.throws(() => searchRepository(repository, "x"), /between 2 and 120/);
});

test("does not search or preview files containing high-confidence secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-repository-secret-"));
  try {
    writeFileSync(join(root, "config.ts"), 'export const password = "synthetic-secret-value";\n');
    const repository = { id: "repo", name: "private", path: root, addedAt: new Date().toISOString() };
    assert.deepEqual(searchRepository(repository, "password"), []);
    assert.throws(() => previewRepositoryFile(repository, "config.ts", 1), /cannot be previewed safely/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
