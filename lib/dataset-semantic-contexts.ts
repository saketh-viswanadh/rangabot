import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { applyAnalyticalSemanticContext, type AnalyticalSemanticContext } from "./analytical-semantic-context.ts";
import type { ApprovedDataset } from "./datasets.ts";
import { writePrivateJsonFileAtomic } from "./private-storage.ts";
import { runtimePaths } from "./runtime-paths.ts";
import type { DatasetColumn } from "./sql-runtime.ts";

export type SemanticUsage = Readonly<{
  tables: Readonly<Record<string, Readonly<{ count: number; lastUsedAt: string }>>>;
  columns: Readonly<Record<string, Readonly<{ count: number; lastUsedAt: string }>>>;
}>;

export type DatasetSemanticMemory = Readonly<{
  version: 1;
  datasetId: string;
  datasetSha256: string;
  revision: number;
  status: "skipped" | "complete";
  updatedAt: string;
  context: AnalyticalSemanticContext;
  usage: SemanticUsage;
}>;

type Registry = Readonly<{ version: 1; memories: readonly DatasetSemanticMemory[] }>;
type StoredDatasetSemanticMemory = Omit<DatasetSemanticMemory, "revision"> & { revision?: number };
let registryPathOverride: string | undefined;
function registryPath() { return registryPathOverride ?? runtimePaths.datasetSemanticContexts; }
const emptyUsage = (): SemanticUsage => ({ tables: {}, columns: {} });

function readText(path: string) {
  const before = lstatSync(/* turbopackIgnore: true */ path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("The local dataset context store is damaged.");
  const descriptor = openSync(/* turbopackIgnore: true */ path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("The local dataset context store is damaged.");
    return readFileSync(descriptor, "utf8");
  } finally { closeSync(descriptor); }
}

function validUsageEntry(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return Number.isSafeInteger(item.count) && Number(item.count) > 0 && typeof item.lastUsedAt === "string" && !Number.isNaN(Date.parse(item.lastUsedAt));
}

function validUsage(value: unknown): value is SemanticUsage {
  if (!value || typeof value !== "object") return false;
  const usage = value as Record<string, unknown>;
  return [usage.tables, usage.columns].every((group) => group && typeof group === "object" && !Array.isArray(group)
    && Object.entries(group as Record<string, unknown>).length <= 2_000
    && Object.entries(group as Record<string, unknown>).every(([key, item]) => key.length > 0 && key.length <= 601 && validUsageEntry(item)));
}

function validMemory(value: unknown): value is StoredDatasetSemanticMemory {
  if (!value || typeof value !== "object") return false;
  const memory = value as Record<string, unknown>;
  return memory.version === 1 && typeof memory.datasetId === "string" && memory.datasetId.length > 0 && memory.datasetId.length <= 200
    && typeof memory.datasetSha256 === "string" && /^[a-f0-9]{64}$/.test(memory.datasetSha256)
    && (memory.revision === undefined || Number.isSafeInteger(memory.revision) && Number(memory.revision) >= 1)
    && (memory.status === "skipped" || memory.status === "complete")
    && typeof memory.updatedAt === "string" && !Number.isNaN(Date.parse(memory.updatedAt))
    && Boolean(memory.context && typeof memory.context === "object" && (memory.context as Record<string, unknown>).version === 1)
    && !("queryEvidence" in (memory.context as Record<string, unknown>)) && validUsage(memory.usage);
}

function readRegistry(): Registry {
  const path = registryPath();
  if (!existsSync(/* turbopackIgnore: true */ path)) return { version: 1, memories: [] };
  let parsed: unknown;
  try { parsed = JSON.parse(readText(path)); }
  catch (error) { if (error instanceof Error && /damaged/.test(error.message)) throw error; throw new Error("The local dataset context store is damaged."); }
  const stored = parsed as { version?: unknown; memories?: unknown };
  if (!parsed || typeof parsed !== "object" || stored.version !== 1 || !Array.isArray(stored.memories)
    || !stored.memories.every(validMemory)) throw new Error("The local dataset context store is damaged.");
  const ids = new Set(stored.memories.map((item) => item.datasetId));
  if (ids.size !== stored.memories.length) throw new Error("The local dataset context store is damaged.");
  return {
    version: 1,
    // Pre-revision semantic memories represent one already-durable context
    // write. Normalize them to revision 1 without weakening the stored data.
    memories: stored.memories.map((memory) => ({ ...memory, revision: memory.revision ?? 1 })),
  };
}

function writeRegistry(memories: readonly DatasetSemanticMemory[]) {
  writePrivateJsonFileAtomic(/* turbopackIgnore: true */ registryPath(), { version: 1, memories });
}

function withoutQueryEvidence(context: AnalyticalSemanticContext): AnalyticalSemanticContext {
  const { queryEvidence: _discarded, ...persisted } = context;
  return persisted;
}

export function getDatasetSemanticMemory(dataset: ApprovedDataset): DatasetSemanticMemory | null {
  const memory = readRegistry().memories.find((item) => item.datasetId === dataset.id);
  return memory?.datasetSha256 === dataset.fileIdentity.sha256 ? memory : null;
}

export class DatasetSemanticMemoryConflictError extends Error {
  readonly currentRevision: number;
  constructor(currentRevision: number) {
    super("Dataset context changed in another local window. Reload it before saving.");
    this.name = "DatasetSemanticMemoryConflictError";
    this.currentRevision = currentRevision;
  }
}

export class DatasetSemanticMemoryDatasetChangedError extends Error {
  constructor() {
    super("The approved dataset changed or was revoked while its context was being saved. Reload the dataset before trying again.");
    this.name = "DatasetSemanticMemoryDatasetChangedError";
  }
}

function sameApprovedDataset(left: ApprovedDataset | null, right: ApprovedDataset) {
  return Boolean(left && left.id === right.id && left.name === right.name && left.path === right.path
    && left.format === right.format && left.sizeBytes === right.sizeBytes && left.addedAt === right.addedAt
    && left.approvalVersion === right.approvalVersion
    && left.fileIdentity.device === right.fileIdentity.device
    && left.fileIdentity.inode === right.fileIdentity.inode
    && left.fileIdentity.sizeBytes === right.fileIdentity.sizeBytes
    && left.fileIdentity.modifiedNs === right.fileIdentity.modifiedNs
    && left.fileIdentity.changedNs === right.fileIdentity.changedNs
    && left.fileIdentity.sha256 === right.fileIdentity.sha256);
}

export function saveDatasetSemanticMemory(input: {
  dataset: ApprovedDataset;
  columns: readonly DatasetColumn[];
  status: "skipped" | "complete";
  context?: AnalyticalSemanticContext;
  expectedRevision: number;
  /** Re-read the approval inside the synchronous read/compare/write boundary. */
  currentDataset?: () => ApprovedDataset | null;
}): DatasetSemanticMemory {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new Error("A valid dataset context revision is required.");
  }
  const context = withoutQueryEvidence(input.context ?? { version: 1 });
  applyAnalyticalSemanticContext(input.columns, context);
  const registry = readRegistry();
  const previous = registry.memories.find((item) => item.datasetId === input.dataset.id && item.datasetSha256 === input.dataset.fileIdentity.sha256);
  const currentRevision = previous?.revision ?? 0;
  if (currentRevision !== input.expectedRevision) throw new DatasetSemanticMemoryConflictError(currentRevision);
  if (input.currentDataset && !sameApprovedDataset(input.currentDataset(), input.dataset)) {
    throw new DatasetSemanticMemoryDatasetChangedError();
  }
  const memory: DatasetSemanticMemory = {
    version: 1, datasetId: input.dataset.id, datasetSha256: input.dataset.fileIdentity.sha256,
    revision: currentRevision + 1,
    status: input.status, updatedAt: new Date().toISOString(), context, usage: previous?.usage ?? emptyUsage(),
  };
  writeRegistry([...registry.memories.filter((item) => item.datasetId !== input.dataset.id), memory]);
  return memory;
}

export function removeDatasetSemanticMemory(datasetId: string) {
  const registry = readRegistry();
  const next = registry.memories.filter((item) => item.datasetId !== datasetId);
  if (next.length !== registry.memories.length) writeRegistry(next);
}

function terms(value: string) {
  return new Set(value.toLocaleLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((item) => item.length > 1));
}
function textScore(requestTerms: Set<string>, values: readonly (string | undefined)[]) {
  const candidates = terms(values.filter(Boolean).join(" "));
  let score = 0;
  for (const value of requestTerms) if (candidates.has(value)) score += 100;
  return score;
}

/** Selects a small deterministic context slice. Usage affects retrieval rank only. */
export function selectDatasetSemanticContext(request: string, memory: DatasetSemanticMemory | null): AnalyticalSemanticContext | undefined {
  if (!memory || memory.status !== "complete") return undefined;
  const requestTerms = terms(request);
  const tableScores = (memory.context.tables ?? []).map((item) => ({ item, score: textScore(requestTerms, [item.table, item.description, ...(item.aliases ?? [])]) + (memory.usage.tables[item.table]?.count ?? 0) }));
  const columnScores = (memory.context.columns ?? []).map((item) => {
    const key = `${item.table}.${item.column}`;
    return { item, key, score: textScore(requestTerms, [item.table, item.column, item.description, ...(item.aliases ?? [])]) + (memory.usage.columns[key]?.count ?? 0) };
  });
  const tables = tableScores.filter((item) => item.score >= 100).sort((a, b) => b.score - a.score || a.item.table.localeCompare(b.item.table)).slice(0, 12).map((item) => item.item);
  const columns = columnScores.filter((item) => item.score >= 100).sort((a, b) => b.score - a.score || a.key.localeCompare(b.key)).slice(0, 48).map((item) => item.item);
  const selectedTables = new Set([...tables.map((item) => item.table), ...columns.map((item) => item.table)]);
  const relationships = (memory.context.relationships ?? []).filter((item) => selectedTables.has(item.fromTable) || selectedTables.has(item.toTable)).slice(0, 24);
  for (const relationship of relationships) { selectedTables.add(relationship.fromTable); selectedTables.add(relationship.toTable); }
  const linkedTables = (memory.context.tables ?? []).filter((item) => selectedTables.has(item.table) && !tables.some((selected) => selected.table === item.table));
  if (!tables.length && !columns.length) {
    const fallbackTables = tableScores.sort((a, b) => b.score - a.score || a.item.table.localeCompare(b.item.table)).slice(0, 4).map((item) => item.item);
    const fallbackColumns = columnScores.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key)).slice(0, 12).map((item) => item.item);
    if (!fallbackTables.length && !fallbackColumns.length) return undefined;
    const fallbackTableNames = new Set([...fallbackTables.map((item) => item.table), ...fallbackColumns.map((item) => item.table)]);
    const fallbackRelationships = (memory.context.relationships ?? []).filter((item) => fallbackTableNames.has(item.fromTable) && fallbackTableNames.has(item.toTable)).slice(0, 12);
    return { version: 1, tables: fallbackTables, columns: fallbackColumns, relationships: fallbackRelationships };
  }
  return { version: 1, tables: [...tables, ...linkedTables].slice(0, 12), columns, relationships };
}

function mentionsIdentifier(sql: string, identifier: string) {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:["\\[]${escaped}["\\]]|(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_]))`, "iu").test(sql);
}

export function verifiedSqlUsage(sql: string, columns: readonly DatasetColumn[]) {
  const tables = [...new Set(columns.flatMap((column) => {
    const table = column.table ?? "dataset";
    return mentionsIdentifier(sql, table) ? [table] : [];
  }))].sort();
  const nameCounts = new Map<string, number>();
  for (const column of columns) nameCounts.set(column.name, (nameCounts.get(column.name) ?? 0) + 1);
  const fields = columns.filter((column) => mentionsIdentifier(sql, column.name)
    && (tables.includes(column.table ?? "dataset") || nameCounts.get(column.name) === 1)).map((column) => `${column.table ?? "dataset"}.${column.name}`).sort();
  return { tables, columns: [...new Set(fields)] };
}

export function recordDatasetSemanticUsage(dataset: ApprovedDataset, usage: { tables: readonly string[]; columns: readonly string[] }) {
  const registry = readRegistry();
  const memory = registry.memories.find((item) => item.datasetId === dataset.id && item.datasetSha256 === dataset.fileIdentity.sha256);
  if (!memory || memory.status !== "complete") return false;
  const now = new Date().toISOString();
  const increment = (group: Readonly<Record<string, Readonly<{ count: number; lastUsedAt: string }>>>, keys: readonly string[]) => {
    const next = { ...group };
    for (const key of keys) next[key] = { count: Math.min((next[key]?.count ?? 0) + 1, Number.MAX_SAFE_INTEGER), lastUsedAt: now };
    return next;
  };
  const updated = { ...memory, updatedAt: now, usage: { tables: increment(memory.usage.tables, usage.tables), columns: increment(memory.usage.columns, usage.columns) } };
  writeRegistry(registry.memories.map((item) => item.datasetId === memory.datasetId ? updated : item));
  return true;
}

export function setDatasetSemanticContextRegistryPathForTests(path: string) { registryPathOverride = path; }
export function resetDatasetSemanticContextRegistryPathForTests() { registryPathOverride = undefined; }
