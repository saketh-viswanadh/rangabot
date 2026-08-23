import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  isMacAppStoreRuntime,
  rememberMacSecurityScopedAccess,
  restoreMacSecurityScopedAccess,
} from "../desktop/electron/macos-security-scoped-access.ts";

test("Mac App Store runtime detection is exact", () => {
  assert.equal(isMacAppStoreRuntime(true), true);
  for (const value of [false, undefined, 1, "true", {}]) assert.equal(isMacAppStoreRuntime(value), false);
});

test("security-scoped bookmarks persist privately, restore, replace by path, and stop exactly once", () => {
  const userDataPath = realpathSync(resolve(mkdtempSync(join(tmpdir(), "rangabot-mas-bookmarks-"))));
  const firstPath = resolve(userDataPath, "synthetic", "one");
  const secondPath = resolve(userDataPath, "synthetic", "two");
  const calls: string[] = [];
  const app = {
    startAccessingSecurityScopedResource(bookmark: string) {
      calls.push(`start:${bookmark}`);
      let stopped = false;
      return () => {
        assert.equal(stopped, false);
        stopped = true;
        calls.push(`stop:${bookmark}`);
      };
    },
  };
  const firstBookmark = Buffer.from("bookmark-one").toString("base64");
  const secondBookmark = Buffer.from("bookmark-two").toString("base64");
  const replacement = Buffer.from("bookmark-one-replacement").toString("base64");
  try {
    const first = rememberMacSecurityScopedAccess({
      app: app as never,
      userDataPath,
      paths: [firstPath, secondPath],
      bookmarks: [firstBookmark, secondBookmark],
    });
    assert.deepEqual(first.paths, [firstPath, secondPath]);
    first.stop();
    first.stop();

    const replaced = rememberMacSecurityScopedAccess({
      app: app as never,
      userDataPath,
      paths: [firstPath],
      bookmarks: [replacement],
    });
    replaced.stop();

    const restored = restoreMacSecurityScopedAccess({ app: app as never, userDataPath });
    assert.deepEqual(restored.paths, [firstPath, secondPath]);
    restored.stop();

    const savedPath = join(userDataPath, "mac-app-store-security-scoped-bookmarks.json");
    assert.equal(lstatSync(savedPath).mode & 0o777, 0o600);
    const saved = JSON.parse(readFileSync(savedPath, "utf8")) as Array<{ path: string; bookmark: string }>;
    assert.deepEqual(saved, [
      { path: firstPath, bookmark: replacement },
      { path: secondPath, bookmark: secondBookmark },
    ]);
    assert.equal(calls.filter((value) => value.startsWith("start:")).length, 5);
    assert.equal(calls.filter((value) => value.startsWith("stop:")).length, 5);
  } finally {
    chmodSync(userDataPath, 0o700);
    rmSync(userDataPath, { recursive: true, force: true });
  }
});

test("security-scoped bookmark persistence fails closed on mismatches and linked destinations", () => {
  const userDataPath = realpathSync(resolve(mkdtempSync(join(tmpdir(), "rangabot-mas-bookmarks-unsafe-"))));
  const selectedPath = resolve(userDataPath, "synthetic", "one");
  const bookmark = Buffer.from("bookmark").toString("base64");
  const app = { startAccessingSecurityScopedResource() { return () => undefined; } };
  try {
    assert.throws(() => rememberMacSecurityScopedAccess({
      app: app as never,
      userDataPath,
      paths: [selectedPath],
      bookmarks: [],
    }), /matching security-scoped permissions/);
    assert.throws(() => rememberMacSecurityScopedAccess({
      app: app as never,
      userDataPath,
      paths: ["relative/path"],
      bookmarks: [bookmark],
    }), /permissions are invalid/);

    const target = join(userDataPath, "target.json");
    const destination = join(userDataPath, "mac-app-store-security-scoped-bookmarks.json");
    writeFileSync(target, "sentinel\n", { mode: 0o600 });
    symlinkSync(target, destination);
    assert.throws(() => rememberMacSecurityScopedAccess({
      app: app as never,
      userDataPath,
      paths: [selectedPath],
      bookmarks: [bookmark],
    }), /not a safe private file|destination is unsafe/);
    assert.equal(readFileSync(target, "utf8"), "sentinel\n");
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
  }
});
