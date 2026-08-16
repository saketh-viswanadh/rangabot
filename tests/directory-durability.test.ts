import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  supportsDirectoryFsync,
  syncDirectoryMetadata,
} from "../lib/directory-durability.ts";

test("directory durability uses POSIX fsync without claiming Windows support", () => {
  assert.equal(supportsDirectoryFsync("win32"), false);
  assert.equal(supportsDirectoryFsync("linux"), true);
  assert.equal(supportsDirectoryFsync("darwin"), true);
});

test("directory durability verifies and synchronizes a real directory", () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-directory-durability-"));
  try {
    assert.doesNotThrow(() => syncDirectoryMetadata(root, "Synthetic durability directory"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("directory durability rejects files before applying platform policy", () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-directory-durability-file-"));
  const file = join(root, "not-a-directory.txt");
  try {
    writeFileSync(file, "unchanged\n");
    assert.throws(
      () => syncDirectoryMetadata(file, "Synthetic durability directory"),
      /must be a real local directory/,
    );
    assert.equal(readFileSync(file, "utf8"), "unchanged\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("directory durability refuses a symbolic-link directory", {
  skip: process.platform === "win32",
}, () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-directory-durability-link-"));
  const target = join(root, "target");
  const link = join(root, "linked-directory");
  try {
    mkdirSync(target);
    writeFileSync(join(target, "sentinel.txt"), "unchanged\n");
    symlinkSync(target, link);
    assert.throws(
      () => syncDirectoryMetadata(link, "Synthetic durability directory"),
      /symbolic link|real local directory/,
    );
    assert.equal(readFileSync(join(target, "sentinel.txt"), "utf8"), "unchanged\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
