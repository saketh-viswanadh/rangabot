import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { approveDataset, resetDatasetRegistryPathForTests, setDatasetRegistryPathForTests } from "../lib/datasets.ts";
import { createSqlExecutionPreview, executeConfirmedSql, maintainSqlConfirmationStore, resetSqlConfirmationStorePathForTests, setSqlConfirmationStorePathForTests, sqlConfirmationTempMaxAgeMs, validateSqlPreviewQuery } from "../lib/sql-confirmations.ts";
import { privateFileMode, supportsPosixPermissions } from "../lib/private-storage.ts";

test("binds one execution to the exact approved dataset and query", async () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-sql-confirm-"));
  const datasetPath = join(root, "sales.csv");
  try {
    writeFileSync(datasetPath, "amount\n10\n20\n");
    setDatasetRegistryPathForTests(join(root, "datasets.json"));
    setSqlConfirmationStorePathForTests(join(root, "confirmations.json"));
    const dataset = approveDataset(datasetPath);
    const preview = await createSqlExecutionPreview(dataset.id, "SELECT sum(amount) AS total FROM dataset");
    const result = await executeConfirmedSql({ confirmationId: preview.confirmationId, token: preview.token, datasetId: dataset.id, query: preview.query });
    assert.deepEqual(result.rows, [["30"]]);
    await assert.rejects(() => executeConfirmedSql({ confirmationId: preview.confirmationId, token: preview.token, datasetId: dataset.id, query: preview.query }), /already used/);
  } finally {
    resetDatasetRegistryPathForTests(); resetSqlConfirmationStorePathForTests(); rmSync(root, { recursive: true, force: true });
  }
});

test("rejects changed queries and changed files after preview", async () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-sql-confirm-"));
  const datasetPath = join(root, "sales.csv");
  try {
    writeFileSync(datasetPath, "amount\n10\n");
    setDatasetRegistryPathForTests(join(root, "datasets.json")); setSqlConfirmationStorePathForTests(join(root, "confirmations.json"));
    const dataset = approveDataset(datasetPath);
    const changedQuery = await createSqlExecutionPreview(dataset.id, "SELECT * FROM dataset");
    await assert.rejects(() => executeConfirmedSql({ confirmationId: changedQuery.confirmationId, token: changedQuery.token, datasetId: dataset.id, query: "SELECT count(*) FROM dataset" }), /changed after preview/);
    const changedFile = await createSqlExecutionPreview(dataset.id, "SELECT * FROM dataset");
    writeFileSync(datasetPath, "amount\n99\n");
    await assert.rejects(() => executeConfirmedSql({ confirmationId: changedFile.confirmationId, token: changedFile.token, datasetId: dataset.id, query: changedFile.query }), /dataset changed after preview/i);
  } finally {
    resetDatasetRegistryPathForTests(); resetSqlConfirmationStorePathForTests(); rmSync(root, { recursive: true, force: true });
  }
});

test("rejects mutating or multiple preview queries", () => {
  assert.throws(() => validateSqlPreviewQuery("DELETE FROM dataset"), /read-only SELECT/);
  assert.throws(() => validateSqlPreviewQuery("SELECT 1; SELECT 2"), /one SQL statement/);
  assert.throws(() => validateSqlPreviewQuery("WITH x AS (DELETE FROM dataset RETURNING *) SELECT * FROM x"), /prohibited/);
});

test("prunes expired confirmations and stale crash-safe temporary files on store read", () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-sql-confirm-maintenance-"));
  const store = join(root, "confirmations.json");
  const stale = `${store}.00000000-0000-4000-8000-000000000001.tmp`;
  const recent = `${store}.00000000-0000-4000-8000-000000000002.tmp`;
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  try {
    setSqlConfirmationStorePathForTests(store);
    writeFileSync(store, `${JSON.stringify([
      { id: "expired", tokenHash: "a", datasetId: "d", datasetSha256: "b", query: "SELECT 1", querySha256: "c", expiresAt: new Date(now - 1).toISOString() },
      { id: "active", tokenHash: "d", datasetId: "d", datasetSha256: "e", query: "SELECT 2", querySha256: "f", expiresAt: new Date(now + 60_000).toISOString() },
    ])}\n`);
    writeFileSync(stale, "abandoned");
    writeFileSync(recent, "possibly active");
    const staleTime = new Date(now - sqlConfirmationTempMaxAgeMs - 1);
    const recentTime = new Date(now - 1_000);
    utimesSync(stale, staleTime, staleTime);
    utimesSync(recent, recentTime, recentTime);

    const result = maintainSqlConfirmationStore(now);

    assert.equal(result.expiredConfirmationsRemoved, 1);
    assert.equal(result.temporaryFilesRemoved, 1);
    assert.deepEqual(result.items.map((item) => item.id), ["active"]);
    assert.deepEqual((JSON.parse(readFileSync(store, "utf8")) as Array<{ id: string }>).map((item) => item.id), ["active"]);
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(recent), true);
    if (supportsPosixPermissions()) assert.equal(statSync(store).mode & 0o777, privateFileMode);
  } finally {
    resetSqlConfirmationStorePathForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ignores unrelated temporary files while maintaining SQL confirmations", () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-sql-confirm-unrelated-"));
  const store = join(root, "confirmations.json");
  const unrelated = join(root, "unrelated.tmp");
  const malformedStoreTemp = `${store}.not-a-uuid.tmp`;
  try {
    setSqlConfirmationStorePathForTests(store);
    writeFileSync(unrelated, "keep");
    writeFileSync(malformedStoreTemp, "keep");
    const result = maintainSqlConfirmationStore();
    assert.equal(result.temporaryFilesRemoved, 0);
    assert.equal(existsSync(unrelated), true);
    assert.equal(existsSync(malformedStoreTemp), true);
  } finally {
    resetSqlConfirmationStorePathForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

test("runs lightweight SQL confirmation maintenance before both local server modes", () => {
  for (const script of ["scripts/start-dev.ts", "scripts/start-server.ts"]) {
    const source = readFileSync(resolve(process.cwd(), script), "utf8");
    assert.match(source, /maintainSqlConfirmationStoreAtPath\(runtimePaths\.sqlConfirmations\)/);
    assert.doesNotMatch(source, /defaultSqlConfirmationStorePath/);
  }
});
