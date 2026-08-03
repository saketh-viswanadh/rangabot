import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { validateApprovedDataset } from "./sql-runtime.ts";

export type ApprovedDataset = { id: string; name: string; path: string; format: "csv" | "parquet" | "duckdb"; sizeBytes: number; addedAt: string };
const defaultRegistryPath = resolve(process.cwd(), "data", "datasets.json");
let registryPath = defaultRegistryPath;

function readRegistry(): ApprovedDataset[] {
  if (!existsSync(/* turbopackIgnore: true */ registryPath)) return [];
  const value: unknown = JSON.parse(readFileSync(/* turbopackIgnore: true */ registryPath, "utf8"));
  if (!Array.isArray(value) || !value.every((item) => item && typeof item === "object"
    && typeof (item as ApprovedDataset).id === "string" && typeof (item as ApprovedDataset).name === "string"
    && typeof (item as ApprovedDataset).path === "string" && ((item as ApprovedDataset).format === "csv" || (item as ApprovedDataset).format === "parquet" || (item as ApprovedDataset).format === "duckdb")
    && typeof (item as ApprovedDataset).sizeBytes === "number" && typeof (item as ApprovedDataset).addedAt === "string")) {
    throw new Error("The local dataset allowlist is damaged.");
  }
  return value as ApprovedDataset[];
}

function writeRegistry(datasets: ApprovedDataset[]) {
  mkdirSync(/* turbopackIgnore: true */ dirname(registryPath), { recursive: true });
  const temporary = `${registryPath}.${randomUUID()}.tmp`;
  writeFileSync(/* turbopackIgnore: true */ temporary, `${JSON.stringify(datasets, null, 2)}\n`, { mode: 0o600 });
  renameSync(/* turbopackIgnore: true */ temporary, registryPath);
}

export function listApprovedDatasets() { return readRegistry(); }
export function getApprovedDataset(id: string) { return readRegistry().find((dataset) => dataset.id === id) ?? null; }

export function approveDataset(inputPath: string): ApprovedDataset {
  if (!inputPath.trim() || inputPath.length > 1024 || !isAbsolute(inputPath)) throw new Error("Enter an absolute CSV, Parquet, or DuckDB file path.");
  let canonical: string;
  try { canonical = realpathSync(inputPath.trim()); } catch { throw new Error("That dataset does not exist or cannot be accessed."); }
  const validated = validateApprovedDataset(canonical);
  const datasets = readRegistry();
  const existing = datasets.find((dataset) => dataset.path === validated.canonical);
  if (existing) return existing;
  const dataset: ApprovedDataset = {
    id: randomUUID(), name: basename(validated.canonical), path: validated.canonical,
    format: validated.extension === ".csv" ? "csv" : validated.extension === ".parquet" ? "parquet" : "duckdb", sizeBytes: validated.sizeBytes, addedAt: new Date().toISOString(),
  };
  writeRegistry([...datasets, dataset]);
  return dataset;
}

export function revokeDataset(id: string) {
  const datasets = readRegistry();
  const next = datasets.filter((dataset) => dataset.id !== id);
  if (next.length === datasets.length) return false;
  writeRegistry(next);
  return true;
}

export function setDatasetRegistryPathForTests(path: string) { registryPath = path; }
export function resetDatasetRegistryPathForTests() { registryPath = defaultRegistryPath; }
