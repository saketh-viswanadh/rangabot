import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { beginProfileRecovery } from "../lib/profile-recovery.ts";

function dataTree(root: string) {
  const records: string[] = [];
  const visit = (path: string) => {
    const status = lstatSync(path, { bigint: true });
    records.push([
      relative(root, path) || ".",
      status.mode.toString(),
      status.size.toString(),
      status.mtimeNs.toString(),
      status.ctimeNs.toString(),
      status.nlink.toString(),
      status.isFile() ? readFileSync(path).toString("base64") : "directory",
    ].join(":"));
    if (status.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    }
  };
  visit(root);
  return records;
}

test("source launchers leave private bytes untouched when Profile Recovery is pending", () => {
  const projectRoot = realpathSync(process.cwd());
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), "rangabot-profile-startup-recovery-")));
  try {
    const confirmations = join(dataRoot, "sql-confirmations.json");
    const committedBatch = join(dataRoot, "artifacts", ".deletion-quarantine", "committed-synthetic");
    mkdirSync(committedBatch, { recursive: true, mode: 0o700 });
    for (const path of [join(dataRoot, "artifacts"), join(dataRoot, "artifacts", ".deletion-quarantine"), committedBatch]) {
      chmodSync(path, 0o700);
    }
    writeFileSync(confirmations, `${JSON.stringify([{
      id: "expired",
      tokenHash: "synthetic-token",
      datasetId: "synthetic-dataset",
      datasetSha256: "a".repeat(64),
      query: "SELECT 1",
      querySha256: "b".repeat(64),
      expiresAt: "2001-01-01T00:00:00.000Z",
    }], null, 2)}\n`, { mode: 0o600 });
    writeFileSync(join(committedBatch, "sentinel.txt"), "must remain\n", { mode: 0o600 });
    beginProfileRecovery({
      managedRoot: dataRoot,
      operation: "default-migration",
      profileId: "44444444-4444-4444-8444-444444444444",
      expectedGeneration: 0,
      now: "2026-08-13T00:00:00.000Z",
    });
    const before = dataTree(dataRoot);

    for (const script of ["scripts/start-dev.ts", "scripts/start-server.ts"]) {
      const child = spawnSync(process.execPath, ["--experimental-strip-types", resolve(projectRoot, script)], {
        cwd: projectRoot,
        env: {
          ...process.env,
          NODE_ENV: script.endsWith("start-server.ts") ? "production" : "development",
          PORT: "43159",
          RANGABOT_RESOURCE_ROOT: projectRoot,
          RANGABOT_DATA_ROOT: dataRoot,
        },
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.notEqual(child.status, 0, `${script} unexpectedly started`);
      assert.match(`${child.stderr}\n${child.stdout}`, /Profile Recovery is required/);
      assert.deepEqual(dataTree(dataRoot), before, `${script} changed private data during Recovery`);
      assert.equal(readFileSync(confirmations, "utf8").includes("expired"), true);
      assert.equal(readFileSync(join(committedBatch, "sentinel.txt"), "utf8"), "must remain\n");
    }
  } finally { rmSync(dataRoot, { recursive: true, force: true }); }
});

test("source launchers bind startup maintenance to the current profile after the app lease", () => {
  for (const script of ["scripts/start-dev.ts", "scripts/start-server.ts"]) {
    const source = readFileSync(resolve(process.cwd(), script), "utf8");
    const noRecovery = source.indexOf("requireNoProfileRecovery(runtimePaths.managedDataRoot)");
    const capture = source.indexOf("const startupProfileBinding = currentProfileSessionBinding()");
    const lease = source.indexOf("const runtimeLease = acquireRuntimeLease({ role: \"app\" })");
    const validate = source.indexOf("assertProfileSessionBindingCurrent(startupProfileBinding)");
    const sqlMaintenance = source.indexOf("maintainSqlConfirmationStoreAtPath(runtimePaths.sqlConfirmations)");
    const artifactMaintenance = source.indexOf("purgeArtifactDeletionQuarantine(runtimePaths.artifactsRoot)");
    const spawn = source.indexOf("const child = spawn(");
    assert.ok(noRecovery >= 0 && noRecovery < capture, script);
    assert.ok(capture < lease && lease < validate, script);
    assert.ok(validate < sqlMaintenance && sqlMaintenance < artifactMaintenance, script);
    assert.ok(artifactMaintenance < spawn, script);
    assert.doesNotMatch(source, /defaultSqlConfirmationStorePath/);
  }
});
