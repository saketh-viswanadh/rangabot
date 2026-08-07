"use strict";

const { DuckDBInstance, StatementType } = require("@duckdb/node-api");

const MAX_ROWS = 200;

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
      return (result.getRows()).map((row) => ({ name: String(row[0]), type: String(row[1]) })).slice(0, 500);
    }
    const result = await connection.runAndReadAll(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'main'
      ORDER BY table_name, ordinal_position
      LIMIT 500
    `);
    return (result.getRows()).map((row) => ({ table: String(row[0]), name: String(row[1]), type: String(row[2]) }));
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
    const allRows = result.getRowsJson();
    return {
      columns: result.columnNames(),
      rows: allRows.slice(0, MAX_ROWS),
      truncated: allRows.length > MAX_ROWS,
    };
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

process.once("message", async (raw) => {
  try {
    const request = assertRequest(raw);
    const value = request.operation === "schema" ? await inspectSchema(request) : await executeQuery(request);
    if (process.send) process.send({ ok: true, value });
  } catch (error) {
    if (process.send) process.send({
      ok: false,
      error: {
        code: error && typeof error === "object" && "code" in error ? String(error.code) : "tool-failure",
        message: error instanceof Error ? error.message : "The local SQL worker failed.",
      },
    });
  } finally {
    process.disconnect();
  }
});
