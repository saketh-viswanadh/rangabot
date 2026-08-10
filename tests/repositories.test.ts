import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { allowRepository, listAllowedRepositories, resetRepositoryRegistryPathForTests, revokeRepository, setRepositoryRegistryPathForTests, validateAllowedRepositoryRoot } from "../lib/repositories.ts";

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
    assert.ok(allowed.rootIdentity?.device);
    assert.ok(allowed.rootIdentity?.inode);
    assert.equal(validateAllowedRepositoryRoot(allowed), realpathSync(repositoryPath));
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

test("requires legacy approvals to be explicitly refreshed before access", () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-repositories-"));
  const repositoryPath = join(root, "legacy-repo");
  const registryPath = join(root, "repositories.json");
  try {
    mkdirSync(repositoryPath);
    writeFileSync(registryPath, `${JSON.stringify([{
      id: "legacy",
      name: "legacy-repo",
      path: realpathSync(repositoryPath),
      addedAt: new Date(0).toISOString(),
    }])}\n`);
    setRepositoryRegistryPathForTests(registryPath);

    const legacy = listAllowedRepositories()[0];
    assert.throws(() => validateAllowedRepositoryRoot(legacy), /predates identity checks/);

    const refreshed = allowRepository(repositoryPath);
    assert.equal(refreshed.id, "legacy");
    assert.ok(refreshed.rootIdentity);
    assert.equal(validateAllowedRepositoryRoot(refreshed), realpathSync(repositoryPath));
  } finally {
    resetRepositoryRegistryPathForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a different directory placed at an approved path", () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-repositories-"));
  const repositoryPath = join(root, "approved-repo");
  const movedPath = join(root, "original-repo");
  const registryPath = join(root, "repositories.json");
  try {
    mkdirSync(repositoryPath);
    setRepositoryRegistryPathForTests(registryPath);
    const allowed = allowRepository(repositoryPath);
    renameSync(repositoryPath, movedPath);
    mkdirSync(repositoryPath);
    assert.throws(() => validateAllowedRepositoryRoot(allowed), /changed or was replaced/);
  } finally {
    resetRepositoryRegistryPathForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a symbolic link placed at an approved root", (context) => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-repositories-"));
  const repositoryPath = join(root, "approved-repo");
  const movedPath = join(root, "original-repo");
  const replacementPath = join(root, "replacement-repo");
  const registryPath = join(root, "repositories.json");
  try {
    mkdirSync(repositoryPath);
    mkdirSync(replacementPath);
    setRepositoryRegistryPathForTests(registryPath);
    const allowed = allowRepository(repositoryPath);
    renameSync(repositoryPath, movedPath);
    try {
      symlinkSync(replacementPath, repositoryPath, "dir");
    } catch (error) {
      context.skip(`Directory symlinks are unavailable on this platform: ${error instanceof Error ? error.message : "unknown error"}`);
      return;
    }
    assert.throws(() => validateAllowedRepositoryRoot(allowed), /changed or is unavailable/);
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
