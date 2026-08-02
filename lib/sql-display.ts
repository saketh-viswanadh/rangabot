export function formatSqlCell(value: unknown) {
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export type AttachedDataset = { id: string; name: string; format: "csv" | "parquet"; sizeBytes: number };
export type SqlDraft = { datasetId: string; query: string };
