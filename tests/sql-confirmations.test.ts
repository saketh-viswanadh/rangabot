import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { approveDataset, resetDatasetRegistryPathForTests, setDatasetRegistryPathForTests } from "../lib/datasets.ts";
import { createSqlExecutionPreview, executeConfirmedSql, resetSqlConfirmationStorePathForTests, setSqlConfirmationStorePathForTests, validateSqlPreviewQuery } from "../lib/sql-confirmations.ts";

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
