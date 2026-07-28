import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { allowRepository, listAllowedRepositories, resetRepositoryRegistryPathForTests, revokeRepository, setRepositoryRegistryPathForTests } from "../lib/repositories.ts";

test("stores canonical repository approvals locally and revokes without touching the folder", () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-repositories-"));
  const repositoryPath = join(root, "tiny-repo");
  const registryPath = join(root, "private", "repositories.json");
  const markerPath = join(repositoryPath, "keep.txt");
  try {
    mkdirSync(repositoryPath);
    writeFileSync(markerPath, "do not delete");
    setRepositoryRegistryPathForTests(registryPath);
    const allowed = allowRepository(repositoryPath);
    assert.equal(allowed.name, "tiny-repo");
    assert.equal(listAllowedRepositories().length, 1);
    assert.equal(allowRepository(repositoryPath).id, allowed.id);
    assert.equal(revokeRepository(allowed.id), true);
    assert.equal(listAllowedRepositories().length, 0);
    assert.equal(readFileSync(markerPath, "utf8"), "do not delete");
  } finally {
    resetRepositoryRegistryPathForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects relative paths and files", () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-repositories-"));
  const registryPath = join(root, "repositories.json");
  const filePath = join(root, "file.txt");
  try {
    writeFileSync(filePath, "not a directory");
    setRepositoryRegistryPathForTests(registryPath);
    assert.throws(() => allowRepository("relative/project"), /absolute folder path/);
    assert.throws(() => allowRepository(filePath), /not a folder/);
  } finally {
    resetRepositoryRegistryPathForTests();
    rmSync(root, { recursive: true, force: true });
  }
});
