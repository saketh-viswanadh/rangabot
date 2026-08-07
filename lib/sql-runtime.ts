import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { createReadStream, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, extname, resolve } from "node:path";

const supportedExtensions = new Set([".csv", ".parquet", ".duckdb"]);
const maxInputBytes = 100 * 1024 * 1024;
const maxRows = 200;
const defaultTimeoutMs = 10_000;
const workerPath = resolve(/* turbopackIgnore: true */ process.cwd(), "lib", "sql-runtime-worker.cjs");
const serverRequire = createRequire(resolve(process.cwd(), "package.json"));
const { fork: forkProcess } = serverRequire("node:child_process") as typeof import("node:child_process");

export type SqlRuntimeFailureCode = "cancelled" | "dataset-changed" | "invalid-query" | "resource-limit" | "timeout" | "tool-failure";

export class SqlRuntimeError extends Error {
  readonly code: SqlRuntimeFailureCode;

  constructor(code: SqlRuntimeFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "SqlRuntimeError";
  }
}

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

export type DatasetColumn = { table?: string; name: string; type: string };

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function cancellationError(signal?: AbortSignal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new SqlRuntimeError("cancelled", "The SQL operation was stopped.");
}

function throwIfCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw cancellationError(signal);
}

async function hashFile(path: string, signal?: AbortSignal) {
  throwIfCancelled(signal);
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  } catch (error) {
    if (signal?.aborted) throw cancellationError(signal);
    throw error;
  }
  return hash.digest("hex");
}

export async function inspectDatasetIdentity(path: string, options: { signal?: AbortSignal } = {}) {
  throwIfCancelled(options.signal);
  const dataset = validateApprovedDataset(path);
  return { ...dataset, sha256: await hashFile(dataset.canonical, options.signal) };
}

export function validateApprovedDataset(path: string) {
  const canonical = realpathSync(path);
  const stat = statSync(canonical);
  if (!stat.isFile()) throw new Error("The approved dataset must be a regular file.");
  const extension = extname(canonical).toLowerCase();
  if (!supportedExtensions.has(extension)) throw new Error("Only CSV, Parquet, and DuckDB datasets are supported.");
  if (stat.size === 0) throw new Error("The approved dataset is empty.");
  if (stat.size > maxInputBytes) throw new SqlRuntimeError("resource-limit", "The approved dataset exceeds the 100 MB execution limit.");
  return { canonical, extension, sizeBytes: stat.size, filename: basename(canonical) };
}

function boundedTimeout(value: number | undefined) {
  return Math.min(Math.max(value ?? defaultTimeoutMs, 100), 30_000);
}

function operationSignal(inputSignal: AbortSignal | undefined, timeoutMs: number, operation: string) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(inputSignal?.reason ?? new SqlRuntimeError("cancelled", `The ${operation} operation was stopped.`));
  if (inputSignal?.aborted) onAbort();
  else inputSignal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new SqlRuntimeError("timeout", `The ${operation} operation exceeded the ${timeoutMs} ms limit.`)), timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      inputSignal?.removeEventListener("abort", onAbort);
    },
  };
}

function terminate(child: ChildProcess) {
  if (child.killed) return;
  child.kill(process.platform === "win32" ? undefined : "SIGKILL");
}

function runDuckDbWorker<T>(request: Record<string, unknown>, signal: AbortSignal, onQueryStart?: () => void): Promise<T> {
  throwIfCancelled(signal);
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const child = forkProcess(workerPath, [], { stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced" });
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      child.removeListener("message", onMessage);
      callback();
    };
    const onAbort = () => finish(() => {
      terminate(child);
      rejectPromise(cancellationError(signal));
    });
    signal.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => finish(() => rejectPromise(new SqlRuntimeError("tool-failure", "The isolated SQL runtime could not start.", { cause: error }))));
    child.once("exit", (code, childSignal) => finish(() => rejectPromise(new SqlRuntimeError("tool-failure", `The isolated SQL runtime exited before returning a result (${childSignal ?? code ?? "unknown"}).`))));
    const onMessage = (message: unknown) => {
      if (message && typeof message === "object" && "progress" in message && message.progress === "query-started") {
        onQueryStart?.();
        return;
      }
      finish(() => {
      if (!message || typeof message !== "object" || !("ok" in message)) {
        rejectPromise(new SqlRuntimeError("tool-failure", "The isolated SQL runtime returned an invalid response."));
        return;
      }
      const response = message as { ok: boolean; value?: T; error?: { code?: string; message?: string } };
      if (response.ok) {
        resolvePromise(response.value as T);
        return;
      }
      const code = response.error?.code === "invalid-query" ? "invalid-query" : "tool-failure";
      rejectPromise(new SqlRuntimeError(code, response.error?.message || "The isolated SQL runtime failed safely."));
      });
    };
    child.on("message", onMessage);
    child.send(request, (error) => {
      if (error) finish(() => rejectPromise(new SqlRuntimeError("tool-failure", "The isolated SQL runtime could not receive its request.", { cause: error })));
    });
  });
}

export async function inspectDatasetSchema(path: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<DatasetColumn[]> {
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const deadline = operationSignal(options.signal, timeoutMs, "SQL schema inspection");
  try {
    throwIfCancelled(deadline.signal);
    const dataset = validateApprovedDataset(path);
    return await runDuckDbWorker<DatasetColumn[]>({ operation: "schema", path: dataset.canonical, extension: dataset.extension }, deadline.signal);
  } finally {
    deadline.cleanup();
  }
}

export async function executeReadOnlySql(input: { approvedDatasetPath: string; query: string; timeoutMs?: number; expectedInputSha256?: string; signal?: AbortSignal; onQueryStart?: () => void }): Promise<SqlExecutionResult> {
  const started = Date.now();
  const timeoutMs = boundedTimeout(input.timeoutMs);
  const deadline = operationSignal(input.signal, timeoutMs, "SQL execution");
  try {
    throwIfCancelled(deadline.signal);
    const dataset = await inspectDatasetIdentity(input.approvedDatasetPath, { signal: deadline.signal });
    if (input.expectedInputSha256 && dataset.sha256 !== input.expectedInputSha256) throw new SqlRuntimeError("dataset-changed", "The approved dataset changed after preview. Create a new preview.");
    const query = input.query.trim().replace(/;\s*$/, "");
    if (!query || query.length > 20_000) throw new SqlRuntimeError("invalid-query", "Provide one SQL query under 20,000 characters.");
    const executed = await runDuckDbWorker<{ columns: string[]; rows: unknown[][]; truncated: boolean }>({
      operation: "execute",
      path: dataset.canonical,
      extension: dataset.extension,
      query,
      notifyQueryStart: Boolean(input.onQueryStart),
    }, deadline.signal, input.onQueryStart);
    const rows = executed.rows.slice(0, maxRows);
    const durationMs = Date.now() - started;
    if (durationMs > timeoutMs) throw new SqlRuntimeError("timeout", `The SQL execution operation exceeded the ${timeoutMs} ms limit.`);
    return {
      columns: executed.columns,
      rows,
      receipt: {
        engine: "duckdb",
        input: { filename: dataset.filename, sha256: dataset.sha256, sizeBytes: dataset.sizeBytes },
        querySha256: digest(query),
        readOnly: true,
        externalAccess: false,
        rowLimit: maxRows,
        returnedRows: rows.length,
        truncated: executed.truncated,
        durationMs,
      },
    };
  } finally {
    deadline.cleanup();
  }
}
