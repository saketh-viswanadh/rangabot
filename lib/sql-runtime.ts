import { createHash } from "node:crypto";
import { createReadStream, realpathSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { DuckDBInstance, StatementType } from "@duckdb/node-api";

const supportedExtensions = new Set([".csv", ".parquet"]);
const maxInputBytes = 100 * 1024 * 1024;
const maxRows = 200;
const defaultTimeoutMs = 10_000;

export type SqlExecutionReceipt = {
  engine: "duckdb";
  input: { filename: string; sha256: string; sizeBytes: number };
  querySha256: string;
  readOnly: true;
  externalAccess: false;
  rowLimit: number;
  returnedRows: number;
  truncated: boolean;
  durationMs: number;
};

export type SqlExecutionResult = {
  columns: string[];
  rows: unknown[][];
  receipt: SqlExecutionReceipt;
};

export type DatasetColumn = { name: string; type: string };

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function inspectDatasetIdentity(path: string) {
  const dataset = validateApprovedDataset(path);
  return { ...dataset, sha256: await hashFile(dataset.canonical) };
}

export function validateApprovedDataset(path: string) {
  const canonical = realpathSync(path);
  const stat = statSync(canonical);
  if (!stat.isFile()) throw new Error("The approved dataset must be a regular file.");
  const extension = extname(canonical).toLowerCase();
  if (!supportedExtensions.has(extension)) throw new Error("Only CSV and Parquet datasets are supported.");
  if (stat.size === 0) throw new Error("The approved dataset is empty.");
  if (stat.size > maxInputBytes) throw new Error("The approved dataset exceeds the 100 MB execution limit.");
  return { canonical, extension, sizeBytes: stat.size, filename: basename(canonical) };
}

export async function inspectDatasetSchema(path: string): Promise<DatasetColumn[]> {
  const dataset = validateApprovedDataset(path);
  const instance = await DuckDBInstance.create(":memory:", { max_memory: "256MB", threads: "2", enable_external_access: "true" });
  const connection = await instance.connect();
  try {
    const reader = dataset.extension === ".csv" ? "read_csv_auto($path)" : "read_parquet($path)";
    await connection.run(`CREATE TABLE dataset AS SELECT * FROM ${reader}`, { path: dataset.canonical });
    await connection.run("SET enable_external_access = false");
    const result = await connection.runAndReadAll("DESCRIBE dataset");
    return (result.getRows() as unknown[][]).map((row) => ({ name: String(row[0]), type: String(row[1]) })).slice(0, 500);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

export async function executeReadOnlySql(input: { approvedDatasetPath: string; query: string; timeoutMs?: number; expectedInputSha256?: string }): Promise<SqlExecutionResult> {
  const dataset = await inspectDatasetIdentity(input.approvedDatasetPath);
  if (input.expectedInputSha256 && dataset.sha256 !== input.expectedInputSha256) throw new Error("The approved dataset changed after preview. Create a new preview.");
  const query = input.query.trim().replace(/;\s*$/, "");
  if (!query || query.length > 20_000) throw new Error("Provide one SQL query under 20,000 characters.");
  const timeoutMs = Math.min(Math.max(input.timeoutMs ?? defaultTimeoutMs, 100), 30_000);
  const instance = await DuckDBInstance.create(":memory:", { max_memory: "256MB", threads: "2", enable_external_access: "true" });
  const connection = await instance.connect();
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reader = dataset.extension === ".csv" ? "read_csv_auto($path)" : "read_parquet($path)";
    await connection.run(`CREATE TABLE dataset AS SELECT * FROM ${reader}`, { path: dataset.canonical });
    await connection.run("SET enable_external_access = false");

    const extracted = await connection.extractStatements(query);
    if (extracted.count !== 1) throw new Error("Only one SQL statement is allowed.");
    const prepared = await extracted.prepare(0);
    if (prepared.statementType !== StatementType.SELECT) throw new Error("Only read-only SELECT queries are allowed.");

    const bounded = `SELECT * FROM (${query}) AS rangabot_result LIMIT ${maxRows + 1}`;
    const execution = connection.runAndReadAll(bounded);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        connection.interrupt();
        reject(new Error(`The SQL query exceeded the ${timeoutMs} ms limit.`));
      }, timeoutMs);
    });
    const result = await Promise.race([execution, timeout]);
    const allRows = result.getRowsJson() as unknown[][];
    const truncated = allRows.length > maxRows;
    const rows = allRows.slice(0, maxRows);
    return {
      columns: result.columnNames(),
      rows,
      receipt: {
        engine: "duckdb",
        input: { filename: dataset.filename, sha256: dataset.sha256, sizeBytes: dataset.sizeBytes },
        querySha256: digest(query),
        readOnly: true,
        externalAccess: false,
        rowLimit: maxRows,
        returnedRows: rows.length,
        truncated,
        durationMs: Date.now() - started,
      },
    };
  } finally {
    if (timer) clearTimeout(timer);
    connection.closeSync();
    instance.closeSync();
  }
}
