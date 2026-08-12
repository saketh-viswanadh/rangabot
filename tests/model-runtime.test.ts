import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { selectManagedModelStore } from "../desktop/electron/model-runtime.ts";

test("uses an existing owner-controlled standard model store in place without copying", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rangabot-model-store-")));
  const standard = join(root, "standard");
  const privateRoot = join(root, "private");
  try {
    mkdirSync(join(standard, "manifests"), { recursive: true, mode: 0o700 });
    mkdirSync(join(standard, "blobs"), { mode: 0o700 });
    assert.equal(selectManagedModelStore({ privateModelsRoot: privateRoot, standardModelsRoot: standard }), standard);
    assert.equal(selectManagedModelStore({ privateModelsRoot: privateRoot }), privateRoot);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("falls back to private storage for an unsafe standard store", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rangabot-model-store-unsafe-")));
  const actual = join(root, "actual");
  const linked = join(root, "linked");
  const privateRoot = join(root, "private");
  try {
    mkdirSync(join(actual, "manifests"), { recursive: true });
    mkdirSync(join(actual, "blobs"));
    symlinkSync(actual, linked);
    assert.equal(selectManagedModelStore({ privateModelsRoot: privateRoot, standardModelsRoot: linked }), privateRoot);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
