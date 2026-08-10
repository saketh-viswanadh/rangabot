"use strict";

const { DuckDBInstance, StatementType } = require("@duckdb/node-api");

const MAX_ROWS = 200;
const MAX_RESULT_COLUMNS = 64;
const MAX_SCHEMA_COLUMNS = 500;
const MAX_COLUMN_NAME_BYTES = 1024;
const MAX_CELL_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_SCHEMA_BYTES = 256 * 1024;
const MAX_NESTED_DEPTH = 16;
const MAX_NESTED_VALUES = 4096;

function resourceLimit(message) {
  const error = new Error(message);
  error.code = "resource-limit";
  return error;
}

function addBytes(current, additional, limit, message) {
  const next = current + additional;
  if (!Number.isSafeInteger(next) || next > limit) throw resourceLimit(message);
  return next;
}

function serializedStringBytes(value, limit, message) {
  const rawBytes = Buffer.byteLength(value, "utf8");
  if (rawBytes > limit) throw resourceLimit(message);
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function serializedCellBytes(value) {
  const message = `A SQL result value exceeded the ${MAX_CELL_BYTES / 1024} KB per-cell limit. Select, aggregate, or shorten the value and try again.`;
  const stack = [{ value, depth: 0 }];
  const seen = new WeakSet();
  let bytes = 0;
  let values = 0;

  while (stack.length) {
    const current = stack.pop();
    values += 1;
    if (values > MAX_NESTED_VALUES || current.depth > MAX_NESTED_DEPTH) throw resourceLimit(message);
    if (current.value === null) {
      bytes = addBytes(bytes, 4, MAX_CELL_BYTES, message);
    } else if (typeof current.value === "string") {
      bytes = addBytes(bytes, serializedStringBytes(current.value, MAX_CELL_BYTES, message), MAX_CELL_BYTES, message);
    } else if (typeof current.value === "number") {
      bytes = addBytes(bytes, Buffer.byteLength(JSON.stringify(current.value) ?? "null"), MAX_CELL_BYTES, message);
    } else if (typeof current.value === "boolean") {
      bytes = addBytes(bytes, current.value ? 4 : 5, MAX_CELL_BYTES, message);
    } else if (Array.isArray(current.value)) {
      if (seen.has(current.value)) throw resourceLimit(message);
      seen.add(current.value);
      bytes = addBytes(bytes, 2 + Math.max(0, current.value.length - 1), MAX_CELL_BYTES, message);
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current.value[index], depth: current.depth + 1 });
      }
    } else if (typeof current.value === "object") {
      if (seen.has(current.value)) throw resourceLimit(message);
      seen.add(current.value);
      const entries = Object.entries(current.value);
      bytes = addBytes(bytes, 2 + Math.max(0, entries.length - 1), MAX_CELL_BYTES, message);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, nested] = entries[index];
        bytes = addBytes(bytes, serializedStringBytes(key, MAX_CELL_BYTES, message) + 1, MAX_CELL_BYTES, message);
        stack.push({ value: nested, depth: current.depth + 1 });
      }
    } else {
      throw resourceLimit("The SQL result contained a value that cannot be transferred safely.");
    }
  }
  return bytes;
}

function assertColumnNames(columns, maximumColumns, totalLimit, context) {
  if (!Array.isArray(columns) || columns.length > maximumColumns) {
    throw resourceLimit(`The ${context} has more than ${maximumColumns} columns. Select fewer columns and try again.`);
  }
  let bytes = 2 + Math.max(0, columns.length - 1);
  for (const column of columns) {
    if (typeof column !== "string") throw resourceLimit(`The ${context} contained an invalid column name.`);
    bytes = addBytes(
      bytes,
      serializedStringBytes(column, MAX_COLUMN_NAME_BYTES, `A ${context} column name exceeded the ${MAX_COLUMN_NAME_BYTES}-byte limit.`),
      totalLimit,
      `The ${context} exceeded its safe transfer limit.`,
    );
  }
  return bytes;
}

function boundedExecutionResult(result) {
  const columns = result.columnNames();
  let bytes = assertColumnNames(columns, MAX_RESULT_COLUMNS, MAX_RESULT_BYTES, "SQL result");
  const allRows = result.getRowsJson();
  const rows = allRows.slice(0, MAX_ROWS);
  bytes = addBytes(bytes, 2 + Math.max(0, rows.length - 1), MAX_RESULT_BYTES, "The SQL result exceeded the 1 MB transfer limit. Narrow or aggregate the query and try again.");
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== columns.length) throw resourceLimit("The SQL result shape could not be transferred safely.");
    bytes = addBytes(bytes, 2 + Math.max(0, row.length - 1), MAX_RESULT_BYTES, "The SQL result exceeded the 1 MB transfer limit. Narrow or aggregate the query and try again.");
    for (const cell of row) {
      bytes = addBytes(bytes, serializedCellBytes(cell), MAX_RESULT_BYTES, "The SQL result exceeded the 1 MB transfer limit. Narrow or aggregate the query and try again.");
    }
  }
  return { columns, rows, truncated: allRows.length > MAX_ROWS };
}

function boundedSchema(rows, hasTables) {
  if (rows.length > MAX_SCHEMA_COLUMNS) throw resourceLimit(`The approved dataset has more than ${MAX_SCHEMA_COLUMNS} columns. Use a narrower view or dataset.`);
  const schema = rows.map((row) => hasTables
    ? { table: String(row[0]), name: String(row[1]), type: String(row[2]) }
    : { name: String(row[0]), type: String(row[1]) });
  let bytes = 2 + Math.max(0, schema.length - 1);
  for (const column of schema) {
    for (const [field, value] of Object.entries(column)) {
      const message = `A schema ${field} exceeded the ${MAX_COLUMN_NAME_BYTES}-byte limit.`;
      bytes = addBytes(bytes, serializedStringBytes(field, MAX_COLUMN_NAME_BYTES, message) + serializedStringBytes(value, MAX_COLUMN_NAME_BYTES, message) + 4, MAX_SCHEMA_BYTES, "The dataset schema exceeded the 256 KB transfer limit.");
    }
  }
  return schema;
}

function normalizeWorkerError(error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "tool-failure";
  const message = error instanceof Error ? error.message : "The local SQL worker failed.";
  if (code === "resource-limit" || /out of memory|memory limit|failed to allocate|allocation size/i.test(message)) {
    return { code: "resource-limit", message: code === "resource-limit" ? message : "The isolated SQL runtime exceeded its memory limit. Narrow or aggregate the query and try again." };
  }
  return { code: code === "invalid-query" ? code : "tool-failure", message };
}

function sendBounded(message) {
  if (!process.send) return;
  const serializedBytes = Buffer.byteLength(JSON.stringify(message), "utf8");
  if (serializedBytes > MAX_RESULT_BYTES + 16 * 1024) {
    const error = resourceLimit("The isolated SQL response exceeded the safe IPC transfer limit.");
    process.send({ ok: false, error: { code: error.code, message: error.message } });
    return;
  }
  process.send(message);
}

function assertRequest(value) {
  if (!value || typeof value !== "object") throw new Error("The SQL worker request is invalid.");
  if (value.operation !== "schema" && value.operation !== "execute") throw new Error("The SQL worker operation is invalid.");
  if (typeof value.path !== "string" || typeof value.extension !== "string") throw new Error("The SQL worker dataset is invalid.");
  if (value.operation === "execute" && typeof value.query !== "string") throw new Error("The SQL worker query is invalid.");
  return value;
}

async function openDataset(request) {
  const instance = request.extension === ".duckdb"
    ? await DuckDBInstance.create(request.path, { access_mode: "READ_ONLY", max_memory: "256MB", threads: "2", enable_external_access: "false" })
    : await DuckDBInstance.create(":memory:", { max_memory: "256MB", threads: "2", enable_external_access: "true" });
  const connection = await instance.connect();
  if (request.extension !== ".duckdb") {
    const reader = request.extension === ".csv" ? "read_csv_auto($path)" : "read_parquet($path)";
    await connection.run(`CREATE TABLE dataset AS SELECT * FROM ${reader}`, { path: request.path });
    await connection.run("SET enable_external_access = false");
  }
  return { instance, connection };
}

async function inspectSchema(request) {
  const { instance, connection } = await openDataset(request);
  try {
    if (request.extension !== ".duckdb") {
      const result = await connection.runAndReadAll("DESCRIBE dataset");
      return boundedSchema(result.getRows(), false);
    }
    const result = await connection.runAndReadAll(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'main'
      ORDER BY table_name, ordinal_position
      LIMIT ${MAX_SCHEMA_COLUMNS + 1}
    `);
    return boundedSchema(result.getRows(), true);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

async function executeQuery(request) {
  const { instance, connection } = await openDataset(request);
  try {
    const extracted = await connection.extractStatements(request.query);
    if (extracted.count !== 1) {
      const error = new Error("Only one SQL statement is allowed.");
      error.code = "invalid-query";
      throw error;
    }
    const prepared = await extracted.prepare(0);
    if (prepared.statementType !== StatementType.SELECT) {
      const error = new Error("Only read-only SELECT queries are allowed.");
      error.code = "invalid-query";
      throw error;
    }
    const bounded = `SELECT * FROM (${request.query}) AS rangabot_result LIMIT ${MAX_ROWS + 1}`;
    if (request.notifyQueryStart && process.send) process.send({ progress: "query-started" });
    const result = await connection.runAndReadAll(bounded);
    return boundedExecutionResult(result);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

process.once("message", async (raw) => {
  try {
    const request = assertRequest(raw);
    const value = request.operation === "schema" ? await inspectSchema(request) : await executeQuery(request);
    sendBounded({ ok: true, value });
  } catch (error) {
    sendBounded({ ok: false, error: normalizeWorkerError(error) });
  } finally {
    process.disconnect();
  }
});
