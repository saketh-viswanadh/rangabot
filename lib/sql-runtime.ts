import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { BigIntStats } from "node:fs";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { chmod, mkdtemp, open, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, extname, join } from "node:path";
import { assertExternalFilesystemPathAccess } from "./desktop-external-filesystem-policy.ts";
import { ensurePrivateDirectory } from "./private-storage.ts";
import { runtimePaths } from "./runtime-paths.ts";

const supportedExtensions = new Set([".csv", ".parquet", ".duckdb"]);
const maxInputBytes = 100 * 1024 * 1024;
const maxRows = 200;
const maxResultColumns = 64;
const maxCellBytes = 64 * 1024;
const maxResultBytes = 1024 * 1024;
const workerHeapMb = 128;
const defaultTimeoutMs = 10_000;
const workerPath = runtimePaths.sqlRuntimeWorker;
const serverRequire = createRequire(runtimePaths.packageJson);
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

export type DatasetFileIdentity = {
  device: string;
  inode: string;
  sizeBytes: number;
  modifiedNs: string;
  changedNs: string;
  sha256: string;
};

type ValidatedDataset = {
  canonical: string;
  extension: string;
  sizeBytes: number;
  filename: string;
};

type DatasetSnapshot = ValidatedDataset & {
  path: string;
  fileIdentity: DatasetFileIdentity;
  cleanup(): Promise<void>;
};

type DatasetBoundaryOptions = {
  signal?: AbortSignal;
  expectedFileIdentity?: DatasetFileIdentity;
  expectedInputSha256?: string;
};

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

function noFollowFlag() {
  return process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
}

function rejectDatasetSymlink(path: string) {
  let status;
  try { status = lstatSync(path); }
  catch { throw new Error("That dataset does not exist or cannot be accessed."); }
  if (status.isSymbolicLink()) throw new Error("Dataset approvals cannot use symbolic links. Choose the real file instead.");
}

function datasetMetadata(path: string, status: BigIntStats): ValidatedDataset {
  if (!status.isFile()) throw new Error("The approved dataset must be a regular file.");
  const sizeBytes = Number(status.size);
  const extension = extname(path).toLowerCase();
  if (!supportedExtensions.has(extension)) throw new Error("Only CSV, Parquet, and DuckDB datasets are supported.");
  if (sizeBytes === 0) throw new Error("The approved dataset is empty.");
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes > maxInputBytes) throw new SqlRuntimeError("resource-limit", "The approved dataset exceeds the 100 MB execution limit.");
  return { canonical: path, extension, sizeBytes, filename: basename(path) };
}

function stableFileFields(status: BigIntStats) {
  return {
    device: status.dev.toString(),
    inode: status.ino.toString(),
    sizeBytes: Number(status.size),
    modifiedNs: status.mtimeNs.toString(),
    changedNs: status.ctimeNs.toString(),
  };
}

function sameStableFile(left: ReturnType<typeof stableFileFields>, right: ReturnType<typeof stableFileFields>) {
  return left.device === right.device
    && left.inode === right.inode
    && left.sizeBytes === right.sizeBytes
    && left.modifiedNs === right.modifiedNs
    && left.changedNs === right.changedNs;
}

function sameApprovedFile(left: DatasetFileIdentity, right: DatasetFileIdentity) {
  return sameStableFile(left, right) && left.sha256 === right.sha256;
}

function changedDatasetError() {
  return new SqlRuntimeError("dataset-changed", "The approved dataset changed after preview or approval, or was replaced. Approve the file again before analysis.");
}

function assertPathReferencesOpenedFile(path: string, openedStatus: BigIntStats) {
  let pathStatus: BigIntStats;
  try {
    pathStatus = lstatSync(path, { bigint: true });
  } catch {
    throw changedDatasetError();
  }
  if (pathStatus.isSymbolicLink() || !pathStatus.isFile() || !sameStableFile(stableFileFields(openedStatus), stableFileFields(pathStatus))) {
    throw changedDatasetError();
  }
}

function canonicalDatasetPath(path: string) {
  rejectDatasetSymlink(path);
  let canonical: string;
  try { canonical = realpathSync(path); }
  catch { throw new Error("That dataset does not exist or cannot be accessed."); }
  rejectDatasetSymlink(canonical);
  return canonical;
}

function openValidatedDatasetSync(path: string) {
  const canonical = canonicalDatasetPath(path);
  let descriptor: number;
  try { descriptor = openSync(canonical, constants.O_RDONLY | noFollowFlag()); }
  catch { throw new Error("That dataset does not exist or cannot be accessed."); }
  try {
    const status = fstatSync(descriptor, { bigint: true });
    assertPathReferencesOpenedFile(canonical, status);
    return { descriptor, dataset: datasetMetadata(canonical, status), status };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function hashDescriptorSync(descriptor: number, sizeBytes: number) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, sizeBytes));
  let position = 0;
  while (position < sizeBytes) {
    const bytesRead = readSync(descriptor, buffer, 0, Math.min(buffer.length, sizeBytes - position), position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (position !== sizeBytes) throw changedDatasetError();
  return hash.digest("hex");
}

export function inspectDatasetForApproval(path: string) {
  assertExternalFilesystemPathAccess(path, "dataset-approval");
  const opened = openValidatedDatasetSync(path);
  try {
    const before = stableFileFields(opened.status);
    const sha256 = hashDescriptorSync(opened.descriptor, opened.dataset.sizeBytes);
    const afterStatus = fstatSync(opened.descriptor, { bigint: true });
    const after = stableFileFields(afterStatus);
    if (!sameStableFile(before, after)) throw changedDatasetError();
    assertPathReferencesOpenedFile(opened.dataset.canonical, afterStatus);
    return { ...opened.dataset, fileIdentity: { ...after, sha256 } satisfies DatasetFileIdentity };
  } finally {
    closeSync(opened.descriptor);
  }
}

export function validateApprovedDataset(path: string) {
  assertExternalFilesystemPathAccess(path, "dataset-identity-validation");
  const opened = openValidatedDatasetSync(path);
  try { return opened.dataset; }
  finally { closeSync(opened.descriptor); }
}

function assertExpectedIdentity(actual: DatasetFileIdentity, options: DatasetBoundaryOptions) {
  if (options.expectedFileIdentity && !sameApprovedFile(actual, options.expectedFileIdentity)) throw changedDatasetError();
  if (options.expectedInputSha256 && actual.sha256 !== options.expectedInputSha256) throw changedDatasetError();
}

async function createDatasetSnapshot(path: string, options: DatasetBoundaryOptions = {}): Promise<DatasetSnapshot> {
  assertExternalFilesystemPathAccess(path, "dataset-snapshot");
  throwIfCancelled(options.signal);
  const canonical = canonicalDatasetPath(path);
  let root: string | undefined;
  let source: Awaited<ReturnType<typeof open>> | undefined;
  let destination: Awaited<ReturnType<typeof open>> | undefined;
  try {
    source = await open(canonical, constants.O_RDONLY | noFollowFlag());
    const beforeStatus = await source.stat({ bigint: true });
    const dataset = datasetMetadata(canonical, beforeStatus);
    const before = stableFileFields(beforeStatus);
    assertPathReferencesOpenedFile(canonical, beforeStatus);
    if (options.expectedFileIdentity && !sameStableFile(before, options.expectedFileIdentity)) throw changedDatasetError();

    ensurePrivateDirectory(runtimePaths.datasetSnapshots, { trustedRoot: runtimePaths.dataRoot });
    root = await mkdtemp(join(runtimePaths.datasetSnapshots, "request-"));
    if (process.platform !== "win32") await chmod(root, 0o700);
    const snapshotPath = join(root, `input${dataset.extension}`);
    destination = await open(snapshotPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, dataset.sizeBytes));
    let position = 0;
    while (position < dataset.sizeBytes) {
      throwIfCancelled(options.signal);
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, dataset.sizeBytes - position), position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written, position + written);
        if (result.bytesWritten === 0) throw new Error("The private dataset snapshot could not be written.");
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    if (position !== dataset.sizeBytes) throw changedDatasetError();
    await destination.sync();
    await destination.close();
    destination = undefined;

    const afterStatus = await source.stat({ bigint: true });
    const after = stableFileFields(afterStatus);
    if (!sameStableFile(before, after)) throw changedDatasetError();
    assertPathReferencesOpenedFile(canonical, afterStatus);
    const fileIdentity = { ...after, sha256: hash.digest("hex") } satisfies DatasetFileIdentity;
    assertExpectedIdentity(fileIdentity, options);
    if (process.platform !== "win32") await chmod(snapshotPath, 0o400);
    await source.close();
    source = undefined;

    let cleaned = false;
    return {
      ...dataset,
      path: snapshotPath,
      fileIdentity,
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        await rm(root!, { recursive: true, force: true });
      },
    };
  } catch (error) {
    try { await destination?.close(); } catch { /* Preserve the boundary failure. */ }
    try { await source?.close(); } catch { /* Preserve the boundary failure. */ }
    if (root) {
      try { await rm(root, { recursive: true, force: true }); } catch { /* Preserve the boundary failure. */ }
    }
    if (options.signal?.aborted) throw cancellationError(options.signal);
    throw error;
  }
}

export async function inspectDatasetIdentity(path: string, options: DatasetBoundaryOptions = {}) {
  const snapshot = await createDatasetSnapshot(path, options);
  try { return { canonical: snapshot.canonical, extension: snapshot.extension, sizeBytes: snapshot.sizeBytes, filename: snapshot.filename, sha256: snapshot.fileIdentity.sha256, fileIdentity: snapshot.fileIdentity }; }
  finally { await snapshot.cleanup(); }
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
    const child = forkProcess(workerPath, [], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json",
      execArgv: [`--max-old-space-size=${workerHeapMb}`],
    });
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
    child.once("exit", (code, childSignal) => finish(() => {
      const resourceExit = childSignal === "SIGABRT" || childSignal === "SIGKILL" || code === 134 || code === 137;
      rejectPromise(resourceExit
        ? new SqlRuntimeError("resource-limit", "The isolated SQL runtime exceeded its memory limit. Narrow or aggregate the query and try again.")
        : new SqlRuntimeError("tool-failure", `The isolated SQL runtime exited before returning a result (${childSignal ?? code ?? "unknown"}).`));
    }));
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
      const code = response.error?.code === "invalid-query"
        ? "invalid-query"
        : response.error?.code === "resource-limit" ? "resource-limit" : "tool-failure";
      rejectPromise(new SqlRuntimeError(code, response.error?.message || "The isolated SQL runtime failed safely."));
      });
    };
    child.on("message", onMessage);
    child.send(request, (error) => {
      if (error) finish(() => rejectPromise(new SqlRuntimeError("tool-failure", "The isolated SQL runtime could not receive its request.", { cause: error })));
    });
  });
}

function serializedJsonBytes(value: unknown) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("not JSON");
    return Buffer.byteLength(serialized, "utf8");
  } catch {
    throw new SqlRuntimeError("resource-limit", "The isolated SQL runtime returned a value that could not be transferred safely.");
  }
}

function validateExecutionPayload(value: { columns: string[]; rows: unknown[][]; truncated: boolean }) {
  if (!Array.isArray(value.columns) || value.columns.length > maxResultColumns) {
    throw new SqlRuntimeError("resource-limit", `The SQL result has more than ${maxResultColumns} columns. Select fewer columns and try again.`);
  }
  if (!Array.isArray(value.rows) || value.rows.length > maxRows) {
    throw new SqlRuntimeError("resource-limit", "The isolated SQL runtime returned more rows than its safe limit.");
  }
  for (const column of value.columns) {
    if (typeof column !== "string" || Buffer.byteLength(column, "utf8") > 1024) {
      throw new SqlRuntimeError("resource-limit", "A SQL result column name exceeded the safe transfer limit.");
    }
  }
  for (const row of value.rows) {
    if (!Array.isArray(row) || row.length !== value.columns.length) {
      throw new SqlRuntimeError("resource-limit", "The SQL result shape could not be transferred safely.");
    }
    for (const cell of row) {
      if (serializedJsonBytes(cell) > maxCellBytes) {
        throw new SqlRuntimeError("resource-limit", `A SQL result value exceeded the ${maxCellBytes / 1024} KB per-cell limit. Select, aggregate, or shorten the value and try again.`);
      }
    }
  }
  if (serializedJsonBytes(value) > maxResultBytes) {
    throw new SqlRuntimeError("resource-limit", "The SQL result exceeded the 1 MB transfer limit. Narrow or aggregate the query and try again.");
  }
  if (typeof value.truncated !== "boolean") throw new SqlRuntimeError("tool-failure", "The isolated SQL runtime returned an invalid response.");
  return value;
}

export async function inspectDatasetSchema(path: string, options: DatasetBoundaryOptions & { timeoutMs?: number } = {}): Promise<DatasetColumn[]> {
  assertExternalFilesystemPathAccess(path, "dataset-schema");
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const deadline = operationSignal(options.signal, timeoutMs, "SQL schema inspection");
  let snapshot: DatasetSnapshot | undefined;
  try {
    throwIfCancelled(deadline.signal);
    snapshot = await createDatasetSnapshot(path, { ...options, signal: deadline.signal });
    return await runDuckDbWorker<DatasetColumn[]>({ operation: "schema", path: snapshot.path, extension: snapshot.extension }, deadline.signal);
  } finally {
    await snapshot?.cleanup();
    deadline.cleanup();
  }
}

export async function executeReadOnlySql(input: {
  approvedDatasetPath: string;
  query: string;
  timeoutMs?: number;
  expectedFileIdentity?: DatasetFileIdentity;
  expectedInputSha256?: string;
  signal?: AbortSignal;
  onSnapshotReady?: (snapshotPath: string) => void;
  onQueryStart?: () => void;
}): Promise<SqlExecutionResult> {
  assertExternalFilesystemPathAccess(input.approvedDatasetPath, "dataset-sql-execution");
  const started = Date.now();
  const timeoutMs = boundedTimeout(input.timeoutMs);
  const deadline = operationSignal(input.signal, timeoutMs, "SQL execution");
  let snapshot: DatasetSnapshot | undefined;
  try {
    throwIfCancelled(deadline.signal);
    const query = input.query.trim().replace(/;\s*$/, "");
    if (!query || query.length > 20_000) throw new SqlRuntimeError("invalid-query", "Provide one SQL query under 20,000 characters.");
    snapshot = await createDatasetSnapshot(input.approvedDatasetPath, {
      signal: deadline.signal,
      expectedFileIdentity: input.expectedFileIdentity,
      expectedInputSha256: input.expectedInputSha256,
    });
    input.onSnapshotReady?.(snapshot.path);
    throwIfCancelled(deadline.signal);
    const executed = await runDuckDbWorker<{ columns: string[]; rows: unknown[][]; truncated: boolean }>({
      operation: "execute",
      path: snapshot.path,
      extension: snapshot.extension,
      query,
      notifyQueryStart: Boolean(input.onQueryStart),
    }, deadline.signal, input.onQueryStart);
    const bounded = validateExecutionPayload(executed);
    const rows = bounded.rows;
    const durationMs = Date.now() - started;
    if (durationMs > timeoutMs) throw new SqlRuntimeError("timeout", `The SQL execution operation exceeded the ${timeoutMs} ms limit.`);
    return {
      columns: bounded.columns,
      rows,
      receipt: {
        engine: "duckdb",
        input: { filename: snapshot.filename, sha256: snapshot.fileIdentity.sha256, sizeBytes: snapshot.sizeBytes },
        querySha256: digest(query),
        readOnly: true,
        externalAccess: false,
        rowLimit: maxRows,
        returnedRows: rows.length,
        truncated: bounded.truncated,
        durationMs,
      },
    };
  } finally {
    await snapshot?.cleanup();
    deadline.cleanup();
  }
}
