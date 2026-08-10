import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getApprovedDataset } from "./datasets.ts";
import { defaultSqlConfirmationStorePath, maintainSqlConfirmationStoreAtPath, sqlConfirmationTempMaxAgeMs, type SqlConfirmationRecord, writeSqlConfirmationStore } from "./sql-confirmation-store.ts";
import { executeReadOnlySql, inspectDatasetIdentity } from "./sql-runtime.ts";

type Confirmation = SqlConfirmationRecord;
const defaultStorePath = defaultSqlConfirmationStorePath;
let storePath = defaultStorePath;
const ttlMs = 5 * 60 * 1000;
export { sqlConfirmationTempMaxAgeMs };

function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function normalizeQuery(query: string) { return query.trim().replace(/;\s*$/, ""); }

function writeStore(items: Confirmation[]) {
  writeSqlConfirmationStore(storePath, items);
}

export function maintainSqlConfirmationStore(now = Date.now()) {
  return maintainSqlConfirmationStoreAtPath(storePath, now);
}

function readStore(): Confirmation[] {
  return maintainSqlConfirmationStore().items;
}

export function validateSqlPreviewQuery(value: string) {
  const query = normalizeQuery(value);
  if (!query || query.length > 20_000) throw new Error("Provide one SQL query under 20,000 characters.");
  if (!/^\s*(?:SELECT|WITH)\b/i.test(query)) throw new Error("Only read-only SELECT queries can be previewed.");
  if (/;[\s\S]*\S/.test(query)) throw new Error("Only one SQL statement can be previewed.");
  if (/\b(?:ATTACH|COPY|CREATE|DELETE|DROP|EXPORT|INSTALL|LOAD|PRAGMA|SET|UPDATE|INSERT|CALL|ALTER|VACUUM)\b/i.test(query)) throw new Error("The query contains a prohibited SQL operation.");
  return query;
}

export async function createSqlExecutionPreview(datasetId: string, rawQuery: string) {
  const dataset = getApprovedDataset(datasetId);
  if (!dataset) throw new Error("Dataset approval not found.");
  const query = validateSqlPreviewQuery(rawQuery);
  const identity = await inspectDatasetIdentity(dataset.path, { expectedFileIdentity: dataset.fileIdentity });
  const token = randomBytes(32).toString("base64url");
  const confirmation: Confirmation = {
    id: randomUUID(), tokenHash: hash(token), datasetId, datasetSha256: identity.sha256,
    query, querySha256: hash(query), expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
  writeStore([...readStore(), confirmation]);
  return {
    confirmationId: confirmation.id, token, expiresAt: confirmation.expiresAt,
    dataset: { id: dataset.id, name: dataset.name, format: dataset.format, sizeBytes: identity.sizeBytes, sha256: identity.sha256 },
    query, limits: { readOnly: true, externalAccess: false, maxRows: 200, timeoutMs: 10_000 },
  };
}

export async function executeConfirmedSql(input: { confirmationId: string; token: string; datasetId: string; query: string }) {
  const items = readStore();
  const confirmation = items.find((item) => item.id === input.confirmationId);
  writeStore(items.filter((item) => item.id !== input.confirmationId));
  if (!confirmation || confirmation.tokenHash !== hash(input.token)) throw new Error("SQL confirmation is missing, expired, or already used.");
  const query = normalizeQuery(input.query);
  if (confirmation.datasetId !== input.datasetId || confirmation.querySha256 !== hash(query) || confirmation.query !== query) throw new Error("The dataset or query changed after preview. Create a new preview.");
  const dataset = getApprovedDataset(input.datasetId);
  if (!dataset) throw new Error("Dataset approval not found.");
  return executeReadOnlySql({
    approvedDatasetPath: dataset.path,
    query,
    expectedFileIdentity: dataset.fileIdentity,
    expectedInputSha256: confirmation.datasetSha256,
  });
}

export function setSqlConfirmationStorePathForTests(path: string) { storePath = path; }
export function resetSqlConfirmationStorePathForTests() { storePath = defaultStorePath; }
