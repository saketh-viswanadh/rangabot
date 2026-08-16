import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  managedModelEnvironment,
  managedModelExecutableName,
  selectManagedModelStore,
  stopManagedModelProcess,
} from "../desktop/electron/model-runtime.ts";

test("uses an existing owner-controlled standard model store in place without copying", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rangabot-model-store-")));
  const standard = join(root, "standard");
  const privateRoot = join(root, "private");
  try {
    mkdirSync(join(standard, "manifests"), { recursive: true, mode: 0o700 });
    mkdirSync(join(standard, "blobs"), { mode: 0o700 });
    assert.equal(selectManagedModelStore({ privateModelsRoot: privateRoot, standardModelsRoot: standard }), standard);
    assert.equal(selectManagedModelStore({ privateModelsRoot: privateRoot, standardModelsRoot: standard, platform: "win32" }), standard);
    assert.equal(realpathSync(standard), standard);
    assert.equal(selectManagedModelStore({ privateModelsRoot: privateRoot }), privateRoot);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows model runtime shutdown terminates runner trees with a bounded force fallback", async () => {
  const child = { exitCode: null as number | null, pid: 901, kill: () => true };
  let finish: () => void = () => undefined;
  const exited = new Promise<void>((resolve) => { finish = resolve; });
  const calls: boolean[] = [];
  await stopManagedModelProcess({
    child,
    exited,
    platform: "win32",
    terminateWindowsTree: async (_pid, force) => {
      calls.push(force);
      if (force) {
        child.exitCode = 1;
        finish();
      }
    },
    gracefulTimeoutMs: 1,
  });
  assert.deepEqual(calls, [false, true]);

  const stuck = { exitCode: null as number | null, pid: 902, kill: () => true };
  await assert.rejects(stopManagedModelProcess({
    child: stuck,
    exited: new Promise<void>(() => undefined),
    platform: "win32",
    terminateWindowsTree: async () => undefined,
    gracefulTimeoutMs: 1,
  }), /process tree did not terminate/);
});

test("falls back to private storage for an unsafe standard store", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rangabot-model-store-unsafe-")));
  const actual = join(root, "actual");
  const linked = join(root, "linked");
  const privateRoot = join(root, "private");
  try {
    mkdirSync(join(actual, "manifests"), { recursive: true });
    mkdirSync(join(actual, "blobs"));
    symlinkSync(actual, linked, process.platform === "win32" ? "junction" : "dir");
    assert.equal(selectManagedModelStore({ privateModelsRoot: privateRoot, standardModelsRoot: linked, platform: "win32" }), privateRoot);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("refuses an escaped or non-directory private model store", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rangabot-private-model-store-unsafe-")));
  const actual = join(root, "actual");
  const linked = join(root, "linked");
  const file = join(root, "file");
  try {
    mkdirSync(actual, { mode: 0o700 });
    symlinkSync(actual, linked, process.platform === "win32" ? "junction" : "dir");
    assert.throws(
      () => selectManagedModelStore({ privateModelsRoot: linked, platform: process.platform }),
      /owner-private real directory/,
    );
    writeFileSync(file, "not a model directory\n");
    assert.throws(
      () => selectManagedModelStore({ privateModelsRoot: file, platform: process.platform }),
      /directory|EEXIST/,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows managed runtime uses ollama.exe, private temp/profile paths, and a minimal OS environment", () => {
  assert.equal(managedModelExecutableName("win32"), "ollama.exe");
  assert.equal(managedModelExecutableName("darwin"), "ollama");
  const boundary = {
    artifactRoot: "C:\\Program Files\\RangaBot\\resources",
    resourceRoot: "C:\\Program Files\\RangaBot\\resources\\rangabot-resources",
    serverEntrypoint: "C:\\Program Files\\RangaBot\\resources\\rangabot-resources\\server.js",
    desktopManifestPath: "C:\\Program Files\\RangaBot\\resources\\rangabot-resources\\desktop\\manifest.json",
    dataRoot: "C:\\Users\\test\\AppData\\Roaming\\RangaBot\\private-data",
    tempRoot: "C:\\Users\\test\\AppData\\Roaming\\RangaBot\\private-data\\tmp",
  };
  const environment = managedModelEnvironment({
    boundary,
    baseUrl: "http://127.0.0.1:43123",
    modelsRoot: "C:\\Users\\test\\.ollama\\models",
    runtimeRoot: "C:\\Program Files\\RangaBot\\resources\\rangabot-resources\\runtime\\ollama",
    platform: "win32",
    baseEnvironment: { SystemRoot: "C:\\Windows", PATH: "C:\\untrusted", NODE_ENV: "test" },
  });
  assert.equal(environment.OLLAMA_MODELS, "C:\\Users\\test\\.ollama\\models");
  assert.equal(environment.TEMP, boundary.tempRoot);
  assert.equal(environment.USERPROFILE, boundary.dataRoot);
  assert.doesNotMatch(environment.PATH ?? "", /untrusted/);
  assert.match(environment.PATH ?? "", /System32/);
});
