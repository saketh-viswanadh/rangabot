import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { approveDataset, getApprovedDataset, listApprovedDatasets, resetDatasetRegistryPathForTests, setDatasetRegistryPathForTests } from "../lib/datasets.ts";
import { executeReadOnlySql, inspectDatasetSchema, SqlRuntimeError } from "../lib/sql-runtime.ts";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "rangabot-dataset-boundary-"));
  setDatasetRegistryPathForTests(join(root, "datasets.json"));
  return {
    root,
    cleanup() {
      resetDatasetRegistryPathForTests();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("binds an approval to the canonical file identity and content digest", () => {
  const fixture = sandbox();
  try {
    const path = join(fixture.root, "sales.csv");
    writeFileSync(path, "amount\n10\n", { mode: 0o600 });
    const dataset = approveDataset(path);
    assert.equal(dataset.approvalVersion, 2);
    assert.equal(dataset.path, realpathSync(path));
    assert.equal(dataset.fileIdentity.sizeBytes, dataset.sizeBytes);
    assert.match(dataset.fileIdentity.sha256, /^[a-f0-9]{64}$/);
    assert.ok(dataset.fileIdentity.device);
    assert.ok(dataset.fileIdentity.inode);
    assert.deepEqual(getApprovedDataset(dataset.id), dataset);
    assert.deepEqual(listApprovedDatasets(), [dataset]);
    if (process.platform !== "win32") {
      assert.equal(lstatSync(join(fixture.root, "datasets.json")).mode & 0o777, 0o600);
      assert.equal(lstatSync(fixture.root).mode & 0o777, 0o700);
    }
  } finally { fixture.cleanup(); }
});

test("rejects a symbolic-link dataset instead of approving its target", { skip: process.platform === "win32" }, () => {
  const fixture = sandbox();
  try {
    const target = join(fixture.root, "target.csv");
    const link = join(fixture.root, "link.csv");
    writeFileSync(target, "value\n1\n", { mode: 0o600 });
    symlinkSync(target, link);
    assert.throws(() => approveDataset(link), /symbolic links/i);
  } finally { fixture.cleanup(); }
});

test("refuses a symbolic-link registry without reading or replacing its target", { skip: process.platform === "win32" }, () => {
  const fixture = sandbox();
  try {
    const victim = join(fixture.root, "victim.json");
    const registry = join(fixture.root, "datasets.json");
    writeFileSync(victim, "[]\n", { mode: 0o600 });
    symlinkSync(victim, registry);
    assert.throws(() => listApprovedDatasets(), /allowlist is damaged/i);
    assert.equal(readFileSync(victim, "utf8"), "[]\n");
  } finally { fixture.cleanup(); }
});

test("requires an explicit reapproval for legacy path-only records and preserves the binding id", () => {
  const fixture = sandbox();
  try {
    const path = join(fixture.root, "legacy.csv");
    writeFileSync(path, "value\n1\n", { mode: 0o600 });
    const legacy = { id: "legacy-id", name: "legacy.csv", path: realpathSync(path), format: "csv", sizeBytes: 8, addedAt: "2026-08-01T00:00:00.000Z" };
    writeFileSync(join(fixture.root, "datasets.json"), `${JSON.stringify([legacy])}\n`, { mode: 0o600 });
    assert.equal(getApprovedDataset("legacy-id"), null);
    assert.deepEqual(listApprovedDatasets(), []);
    const rebound = approveDataset(path);
    assert.equal(rebound.id, "legacy-id");
    assert.equal(rebound.approvalVersion, 2);
    assert.deepEqual(getApprovedDataset("legacy-id"), rebound);
  } finally { fixture.cleanup(); }
});

test("rejects path replacement and in-place content drift against the approved identity", async () => {
  const fixture = sandbox();
  try {
    const path = join(fixture.root, "approved.csv");
    writeFileSync(path, "value\n1\n", { mode: 0o600 });
    const dataset = approveDataset(path);
    renameSync(path, join(fixture.root, "original.csv"));
    writeFileSync(path, "value\n9\n", { mode: 0o600 });
    await assert.rejects(
      () => inspectDatasetSchema(path, { expectedFileIdentity: dataset.fileIdentity }),
      (error: unknown) => error instanceof SqlRuntimeError && error.code === "dataset-changed",
    );

    const rebound = approveDataset(path);
    assert.equal(rebound.id, dataset.id);
    writeFileSync(path, "value\n8\n", { mode: 0o600 });
    await assert.rejects(
      () => executeReadOnlySql({ approvedDatasetPath: path, expectedFileIdentity: rebound.fileIdentity, query: "SELECT * FROM dataset" }),
      (error: unknown) => error instanceof SqlRuntimeError && error.code === "dataset-changed",
    );
  } finally { fixture.cleanup(); }
});

test("executes from the exact private snapshot that was validated and removes it after success", async () => {
  const fixture = sandbox();
  try {
    const path = join(fixture.root, "snapshot.csv");
    writeFileSync(path, "value\n1\n", { mode: 0o600 });
    const dataset = approveDataset(path);
    let snapshotPath = "";
    const result = await executeReadOnlySql({
      approvedDatasetPath: path,
      expectedFileIdentity: dataset.fileIdentity,
      expectedInputSha256: dataset.fileIdentity.sha256,
      query: "SELECT value FROM dataset",
      onSnapshotReady(candidate) {
        snapshotPath = candidate;
        assert.equal(lstatSync(candidate).isSymbolicLink(), false);
        if (process.platform !== "win32") {
          assert.equal(lstatSync(candidate).mode & 0o777, 0o400);
          assert.equal(lstatSync(dirname(candidate)).mode & 0o777, 0o700);
        }
        writeFileSync(path, "value\n9\n", { mode: 0o600 });
      },
    });
    assert.deepEqual(result.rows, [["1"]]);
    assert.equal(result.receipt.input.sha256, dataset.fileIdentity.sha256);
    assert.ok(snapshotPath);
    assert.equal(existsSync(snapshotPath), false);
    assert.equal(existsSync(dirname(snapshotPath)), false);
  } finally { fixture.cleanup(); }
});

test("removes request snapshots after worker rejection and user cancellation", async () => {
  const fixture = sandbox();
  try {
    const path = join(fixture.root, "cleanup.csv");
    writeFileSync(path, "value\n1\n", { mode: 0o600 });
    const dataset = approveDataset(path);
    let rejectedSnapshot = "";
    await assert.rejects(() => executeReadOnlySql({
      approvedDatasetPath: path,
      expectedFileIdentity: dataset.fileIdentity,
      query: "DELETE FROM dataset",
      onSnapshotReady(candidate) { rejectedSnapshot = candidate; },
    }), /read-only SELECT/);
    assert.ok(rejectedSnapshot);
    assert.equal(existsSync(dirname(rejectedSnapshot)), false);

    const controller = new AbortController();
    let cancelledSnapshot = "";
    await assert.rejects(() => executeReadOnlySql({
      approvedDatasetPath: path,
      expectedFileIdentity: dataset.fileIdentity,
      query: "SELECT * FROM dataset",
      signal: controller.signal,
      onSnapshotReady(candidate) { cancelledSnapshot = candidate; controller.abort(); },
    }), (error: unknown) => error instanceof DOMException && error.name === "AbortError");
    assert.ok(cancelledSnapshot);
    assert.equal(existsSync(dirname(cancelledSnapshot)), false);
  } finally { fixture.cleanup(); }
});

test("registry identity metadata remains server-only", () => {
  const route = readFileSync(new URL("../app/api/datasets/route.ts", import.meta.url), "utf8");
  assert.match(route, /const \{ id, name, format, sizeBytes, addedAt \} = dataset/);
  assert.doesNotMatch(route, /fileIdentity\s*[,}]/);
});
