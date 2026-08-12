import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import {
  assertExternalFilesystemPathAccess,
  assertExternalRegistryEntriesAllowed,
} from "./desktop-external-filesystem-policy.ts";
import { writePrivateJsonFileAtomic } from "./private-storage.ts";
import { runtimePaths } from "./runtime-paths.ts";
import { inspectDatasetForApproval, type DatasetFileIdentity } from "./sql-runtime.ts";

export type ApprovedDataset = {
  id: string;
  name: string;
  path: string;
  format: "csv" | "parquet" | "duckdb";
  sizeBytes: number;
  addedAt: string;
  approvalVersion: 2;
  fileIdentity: DatasetFileIdentity;
};
export type DatasetDescriptor = Pick<ApprovedDataset, "id" | "name" | "path" | "format" | "sizeBytes" | "addedAt">;
type LegacyApprovedDataset = Omit<ApprovedDataset, "approvalVersion" | "fileIdentity">;
type StoredDataset = ApprovedDataset | LegacyApprovedDataset;
let registryPathOverride: string | undefined;
function currentRegistryPath() { return registryPathOverride ?? runtimePaths.datasetsRegistry; }

function validFileIdentity(value: unknown): value is DatasetFileIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Record<string, unknown>;
  return typeof identity.device === "string" && identity.device.length > 0
    && typeof identity.inode === "string" && identity.inode.length > 0
    && Number.isSafeInteger(identity.sizeBytes) && Number(identity.sizeBytes) > 0
    && typeof identity.modifiedNs === "string" && identity.modifiedNs.length > 0
    && typeof identity.changedNs === "string" && identity.changedNs.length > 0
    && typeof identity.sha256 === "string" && /^[a-f0-9]{64}$/.test(identity.sha256);
}

function validBaseDataset(item: unknown): item is LegacyApprovedDataset {
  return Boolean(item && typeof item === "object"
    && typeof (item as LegacyApprovedDataset).id === "string" && typeof (item as LegacyApprovedDataset).name === "string"
    && typeof (item as LegacyApprovedDataset).path === "string" && ((item as LegacyApprovedDataset).format === "csv" || (item as LegacyApprovedDataset).format === "parquet" || (item as LegacyApprovedDataset).format === "duckdb")
    && typeof (item as LegacyApprovedDataset).sizeBytes === "number" && typeof (item as LegacyApprovedDataset).addedAt === "string");
}

function isBoundApproval(item: StoredDataset): item is ApprovedDataset {
  const candidate = item as Partial<ApprovedDataset>;
  return candidate.approvalVersion === 2 && validFileIdentity(candidate.fileIdentity);
}

function readRegistryText() {
  const registryPath = currentRegistryPath();
  let pathStatus;
  try { pathStatus = lstatSync(/* turbopackIgnore: true */ registryPath, { bigint: true }); }
  catch { throw new Error("The local dataset allowlist is damaged."); }
  if (pathStatus.isSymbolicLink() || !pathStatus.isFile()) throw new Error("The local dataset allowlist is damaged.");
  let descriptor: number;
  try {
    descriptor = openSync(
      /* turbopackIgnore: true */ registryPath,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
  }
  catch { throw new Error("The local dataset allowlist is damaged."); }
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== pathStatus.dev || opened.ino !== pathStatus.ino) throw new Error("The local dataset allowlist is damaged.");
    return readFileSync(descriptor, "utf8");
  } finally { closeSync(descriptor); }
}

function readRegistry(): StoredDataset[] {
  const registryPath = currentRegistryPath();
  if (!existsSync(/* turbopackIgnore: true */ registryPath)) return [];
  const value: unknown = JSON.parse(readRegistryText());
  if (!Array.isArray(value) || !value.every((item) => validBaseDataset(item)
    && (((item as Partial<ApprovedDataset>).approvalVersion === undefined && (item as Partial<ApprovedDataset>).fileIdentity === undefined)
      || isBoundApproval(item as StoredDataset)))) {
    throw new Error("The local dataset allowlist is damaged.");
  }
  assertExternalRegistryEntriesAllowed(value);
  return value as StoredDataset[];
}

function writeRegistry(datasets: StoredDataset[]) {
  writePrivateJsonFileAtomic(/* turbopackIgnore: true */ currentRegistryPath(), datasets);
}

export function listApprovedDatasets() { return readRegistry().filter(isBoundApproval); }
export function getApprovedDataset(id: string) {
  const dataset = readRegistry().find((item) => item.id === id);
  return dataset && isBoundApproval(dataset) ? dataset : null;
}

function sameFileIdentity(left: DatasetFileIdentity, right: DatasetFileIdentity) {
  return left.device === right.device && left.inode === right.inode && left.sizeBytes === right.sizeBytes
    && left.modifiedNs === right.modifiedNs && left.changedNs === right.changedNs && left.sha256 === right.sha256;
}

export function approveDataset(inputPath: string): ApprovedDataset {
  assertExternalFilesystemPathAccess(inputPath, "dataset-approval");
  if (!inputPath.trim() || inputPath.length > 1024 || !isAbsolute(inputPath)) throw new Error("Enter an absolute CSV, Parquet, or DuckDB file path.");
  const validated = inspectDatasetForApproval(inputPath.trim());
  const datasets = readRegistry();
  const existing = datasets.find((dataset) => dataset.path === validated.canonical);
  if (existing && isBoundApproval(existing) && sameFileIdentity(existing.fileIdentity, validated.fileIdentity)) return existing;
  const dataset: ApprovedDataset = {
    id: existing?.id ?? randomUUID(), name: basename(validated.canonical), path: validated.canonical,
    format: validated.extension === ".csv" ? "csv" : validated.extension === ".parquet" ? "parquet" : "duckdb",
    sizeBytes: validated.sizeBytes, addedAt: new Date().toISOString(), approvalVersion: 2, fileIdentity: validated.fileIdentity,
  };
  writeRegistry(existing ? datasets.map((item) => item.id === existing.id ? dataset : item) : [...datasets, dataset]);
  return dataset;
}

export function revokeDataset(id: string) {
  const datasets = readRegistry();
  const next = datasets.filter((dataset) => dataset.id !== id);
  if (next.length === datasets.length) return false;
  writeRegistry(next);
  return true;
}

export function setDatasetRegistryPathForTests(path: string) { registryPathOverride = path; }
export function resetDatasetRegistryPathForTests() { registryPathOverride = undefined; }
