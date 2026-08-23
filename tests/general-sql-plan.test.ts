import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { auditGeneralSqlPlan, compileGeneralSqlPlan, parseGeneralSqlPlan, resolveGeneralSqlPlan, shouldUseGeneralSqlPlan, type GeneralSqlPlan } from "../lib/general-sql-plan.ts";
import { executeReadOnlySql } from "../lib/sql-runtime.ts";

const schema = [
  { table: "categories", name: "category_id", type: "INTEGER" },
  { table: "products", name: "product_id", type: "INTEGER" },
  { table: "products", name: "category_id", type: "INTEGER" },
  { table: "sales", name: "sale_id", type: "INTEGER" },
  { table: "sales", name: "product_id", type: "INTEGER" },
  { table: "sales", name: "amount", type: "DOUBLE" },
  { table: "transactions", name: "transaction_id", type: "INTEGER" },
  { table: "transactions", name: "account_id", type: "INTEGER" },
  { table: "transactions", name: "occurred_on", type: "DATE" },
  { table: "transactions", name: "amount", type: "DOUBLE" },
];

function plan(overrides: Partial<GeneralSqlPlan>): GeneralSqlPlan {
  return parseGeneralSqlPlan(JSON.stringify({ action: "query", source: "transactions", dimensions: [], filters: [], aggregates: [], windows: [], having: [], qualify: [], orderBy: [], limit: 0, explanation: "Verified relational plan.", ...overrides }));
}

test("compiles grouped ranking and running windows from a typed relational vocabulary", () => {
  const top = plan({
    source: "sales", dimensions: ["products.category_id", "sales.product_id"],
    aggregates: [{ slot: "metric_1", aggregate: "sum", field: "sales.amount", distinct: false }],
    windows: [{ slot: "window_1", function: "row_number", input: "", partitionBy: ["products.category_id"], orderBy: [{ field: "metric_1", direction: "desc" }, { field: "sales.product_id", direction: "asc" }], frameRows: 0 }],
    qualify: [{ window: "window_1", operator: "lte", value: 2 }], orderBy: [{ field: "products.category_id", direction: "asc" }, { field: "window_1", direction: "asc" }],
  });
  const topSql = compileGeneralSqlPlan(top, schema).query;
  assert.match(topSql, /JOIN "products" USING \("product_id"\)/);
  assert.match(topSql, /SUM\("sales"\."amount"\) AS "metric_1"/);
  assert.match(topSql, /ROW_NUMBER\(\) OVER \(PARTITION BY "category_id" ORDER BY "metric_1" DESC, "product_id" ASC\)/);
  assert.match(topSql, /WHERE "window_1" <= 2/);

  const running = plan({
    dimensions: ["transactions.transaction_id", "transactions.account_id", "transactions.occurred_on", "transactions.amount"],
    windows: [{ slot: "window_1", function: "running_sum", input: "transactions.amount", partitionBy: ["transactions.account_id"], orderBy: [{ field: "transactions.occurred_on", direction: "asc" }, { field: "transactions.transaction_id", direction: "asc" }], frameRows: 0 }],
    orderBy: [{ field: "transactions.account_id", direction: "asc" }, { field: "transactions.occurred_on", direction: "asc" }],
  });
  assert.match(compileGeneralSqlPlan(running, schema).query, /SUM\("amount"\) OVER \(PARTITION BY "account_id" ORDER BY "occurred_on" ASC, "transaction_id" ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW\)/);
});

test("executes general grouped ranking and cumulative totals with exact results", async () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-general-sql-")); const database = join(root, "fixture.duckdb");
  const instance = await DuckDBInstance.create(database); const connection = await instance.connect();
  try {
    await connection.run("CREATE TABLE products(product_id INTEGER, category_id INTEGER); INSERT INTO products VALUES (1,10),(2,10),(3,10),(4,20),(5,20); CREATE TABLE sales(sale_id INTEGER,product_id INTEGER,amount DOUBLE); INSERT INTO sales VALUES (1,1,5),(2,1,6),(3,2,9),(4,3,2),(5,4,7),(6,5,8); CREATE TABLE transactions(transaction_id INTEGER,account_id INTEGER,occurred_on DATE,amount DOUBLE); INSERT INTO transactions VALUES (1,7,'2026-01-01',4),(2,7,'2026-01-02',3),(3,8,'2026-01-01',5);");
  } finally { connection.closeSync(); instance.closeSync(); }
  try {
    const top = plan({ source: "sales", dimensions: ["products.category_id", "sales.product_id"], aggregates: [{ slot: "metric_1", aggregate: "sum", field: "sales.amount", distinct: false }], windows: [{ slot: "window_1", function: "row_number", input: "", partitionBy: ["products.category_id"], orderBy: [{ field: "metric_1", direction: "desc" }, { field: "sales.product_id", direction: "asc" }], frameRows: 0 }], qualify: [{ window: "window_1", operator: "lte", value: 2 }], orderBy: [{ field: "products.category_id", direction: "asc" }, { field: "window_1", direction: "asc" }] });
    const ranked = await executeReadOnlySql({ approvedDatasetPath: database, query: compileGeneralSqlPlan(top, schema).query });
    assert.deepEqual(ranked.rows, [[10, 1, 11, "1"], [10, 2, 9, "2"], [20, 5, 8, "1"], [20, 4, 7, "2"]]);
    const running = plan({ dimensions: ["transactions.transaction_id", "transactions.account_id", "transactions.occurred_on", "transactions.amount"], windows: [{ slot: "window_1", function: "running_sum", input: "transactions.amount", partitionBy: ["transactions.account_id"], orderBy: [{ field: "transactions.occurred_on", direction: "asc" }, { field: "transactions.transaction_id", direction: "asc" }], frameRows: 0 }], orderBy: [{ field: "transactions.account_id", direction: "asc" }, { field: "transactions.transaction_id", direction: "asc" }] });
    const cumulative = await executeReadOnlySql({ approvedDatasetPath: database, query: compileGeneralSqlPlan(running, schema).query });
    assert.deepEqual(cumulative.rows, [[1, 7, "2026-01-01", 4, 4], [2, 7, "2026-01-02", 3, 7], [3, 8, "2026-01-01", 5, 5]]);

    const median = resolveGeneralSqlPlan("Find the median transaction amount across transactions.", schema)!;
    assert.deepEqual((await executeReadOnlySql({ approvedDatasetPath: database, query: compileGeneralSqlPlan(median, schema).query })).rows, [[4]]);
    const percentile = resolveGeneralSqlPlan("Return the 90th percentile of transaction amount for transactions.", schema)!;
    assert.deepEqual((await executeReadOnlySql({ approvedDatasetPath: database, query: compileGeneralSqlPlan(percentile, schema).query })).rows, [[4.8]]);
    const share = resolveGeneralSqlPlan("Show each account ID and its share of the total transaction amount.", schema)!;
    const shares = (await executeReadOnlySql({ approvedDatasetPath: database, query: compileGeneralSqlPlan(share, schema).query })).rows;
    assert.equal(shares[0][0], 7); assert.ok(Math.abs(Number(shares[0][2]) - 58.333333333333336) < 1e-9);
    assert.equal(shares[1][0], 8); assert.ok(Math.abs(Number(shares[1][2]) - 41.666666666666664) < 1e-9);
    const lag = resolveGeneralSqlPlan("Show every transaction ID with the previous transaction amount for the same account, ordered by occurred_on and transaction ID.", schema)!;
    assert.deepEqual((await executeReadOnlySql({ approvedDatasetPath: database, query: compileGeneralSqlPlan(lag, schema).query })).rows, [[1, null], [2, 4], [3, null]]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("general SQL grammar rejects unsafe structure and unsupported semantics", () => {
  assert.throws(() => plan({ aggregates: [{ slot: "metric_2", aggregate: "sum", field: "transactions.amount", distinct: false }] }), /sequential/);
  assert.throws(() => plan({ windows: [{ slot: "window_1", function: "moving_avg", input: "transactions.amount", partitionBy: [], orderBy: [{ field: "transactions.occurred_on", direction: "asc" }], frameRows: 0 }] }), /moving averages/);
  assert.throws(() => plan({ filters: [{ column: "transactions.amount", operator: "eq", value: "1", extra: "DROP" } as never] }), /unexpected/);
  const unsupported = auditGeneralSqlPlan(plan({ dimensions: ["transactions.account_id"] }), "Show transaction amounts.", schema);
  assert.equal(unsupported.action, "clarify");
  assert.equal(shouldUseGeneralSqlPlan("Show a running total of amount per account"), true);
  assert.equal(shouldUseGeneralSqlPlan("What is total amount?"), false);
  assert.equal(shouldUseGeneralSqlPlan("What is the average total amount per account?"), false);
  assert.throws(() => compileGeneralSqlPlan(plan({ dimensions: ["transactions.missing"] }), schema), /Unavailable general SQL field/);
  assert.throws(() => compileGeneralSqlPlan(plan({ dimensions: ["transactions.account_id"], filters: [{ column: "transactions.amount", operator: "eq", value: "1'; DROP TABLE transactions; --" }] }), schema), /Invalid numeric/);
  assert.throws(() => compileGeneralSqlPlan(plan({ source: "transactions", dimensions: ["products.category_id", "transactions.account_id"] }), schema), /join path/);
  const ungrounded = auditGeneralSqlPlan(plan({ dimensions: ["transactions.account_id"], filters: [{ column: "transactions.amount", operator: "gt", value: "999" }] }), "Show amount by account.", schema);
  assert.equal(ungrounded.action, "clarify");
});

test("decomposes common general SQL requests before using the local model", () => {
  const running = resolveGeneralSqlPlan("Show transaction ID, account ID, occurred on, amount, and the running total of amount per account ordered by occurred on then transaction ID.", schema);
  assert.deepEqual({ source: running?.source, windows: running?.windows, dimensions: running?.dimensions }, {
    source: "transactions",
    dimensions: ["transactions.transaction_id", "transactions.account_id", "transactions.occurred_on", "transactions.amount"],
    windows: [{ slot: "window_1", function: "running_sum", input: "transactions.amount", partitionBy: ["transactions.account_id"], orderBy: [{ field: "transactions.occurred_on", direction: "asc" }, { field: "transactions.transaction_id", direction: "asc" }], frameRows: 0 }],
  });
  assert.equal(resolveGeneralSqlPlan("Use a recursive query over transactions.", schema)?.action, "unavailable");
  assert.equal(resolveGeneralSqlPlan("Show the top accounts.", schema)?.action, "clarify");
});

test("recognizes broader business phrasing and compiles bounded expert operations", () => {
  const cumulative = resolveGeneralSqlPlan("For every transaction, calculate the accumulated total of amount per account ordered by occurred on then transaction ID.", schema);
  assert.equal(cumulative?.windows[0]?.function, "running_sum");

  const rolling = resolveGeneralSqlPlan("Show transaction ID, account ID, occurred on, amount, and the rolling mean of amount per account over 2 previous rows, ordered by occurred on then transaction ID.", schema);
  assert.deepEqual({ function: rolling?.windows[0]?.function, frameRows: rolling?.windows[0]?.frameRows }, { function: "moving_avg", frameRows: 2 });

  const threshold = resolveGeneralSqlPlan("List account ID and total transaction amount from transactions only for accounts whose total transaction amount is at least 20, ordered descending.", schema);
  assert.deepEqual(threshold?.having, [{ metric: "metric_1", operator: "gte", value: 20 }]);

  const top = resolveGeneralSqlPlan("List the top 2 transaction IDs by transaction amount; use lower transaction ID for ties.", schema);
  assert.equal(top?.orderBy[0]?.direction, "desc");

  const median = resolveGeneralSqlPlan("Find the median transaction amount across transactions.", schema);
  assert.deepEqual(median?.aggregates, [{ slot: "metric_1", aggregate: "median", field: "transactions.amount", distinct: false }]);
  assert.match(compileGeneralSqlPlan(median!, schema).query, /MEDIAN\("transactions"\."amount"\)/);

  const percentile = resolveGeneralSqlPlan("Return the 90th percentile of transaction amount for transactions.", schema);
  assert.deepEqual(percentile?.aggregates, [{ slot: "metric_1", aggregate: "quantile_90", field: "transactions.amount", distinct: false }]);
  assert.match(compileGeneralSqlPlan(percentile!, schema).query, /QUANTILE_CONT\("transactions"\."amount", 0\.9\)/);

  const share = resolveGeneralSqlPlan("Show each account ID and its share of the total transaction amount.", schema);
  assert.equal(share?.windows[0]?.function, "share_of_total");
  assert.match(compileGeneralSqlPlan(share!, schema).query, /100\.0 \* "metric_1" \/ NULLIF\(SUM\("metric_1"\) OVER \(\), 0\)/);

  const lag = resolveGeneralSqlPlan("Show every transaction ID with the previous transaction amount for the same account, ordered by occurred_on and transaction ID.", schema);
  assert.deepEqual({ dimensions: lag?.dimensions, function: lag?.windows[0]?.function }, { dimensions: ["transactions.transaction_id"], function: "lag" });
  const lagSql = compileGeneralSqlPlan(lag!, schema).query;
  assert.match(lagSql, /LAG\("amount"\) OVER \(PARTITION BY "account_id" ORDER BY "occurred_on" ASC, "transaction_id" ASC\)/);
  assert.match(lagSql, /SELECT "transaction_id", "window_1" FROM "window_result"/);

  for (const request of ["Union the account populations.", "Build a cohort retention table.", "Return accounts where a correlated exists query finds a match."]) {
    assert.equal(shouldUseGeneralSqlPlan(request), true, request);
    assert.equal(resolveGeneralSqlPlan(request, schema)?.action, "unavailable", request);
  }
});

test("uses schema relationships to resolve repeated measures and grouping names", () => {
  const repeated = [
    { table: "stores", name: "store_id", type: "INTEGER" }, { table: "stores", name: "region", type: "VARCHAR" },
    { table: "sales", name: "sale_id", type: "INTEGER" }, { table: "sales", name: "store_id", type: "INTEGER" }, { table: "sales", name: "revenue", type: "DOUBLE" },
    { table: "hotels", name: "hotel_id", type: "INTEGER" }, { table: "hotels", name: "city", type: "VARCHAR" },
    { table: "bookings", name: "booking_id", type: "INTEGER" }, { table: "bookings", name: "hotel_id", type: "INTEGER" }, { table: "bookings", name: "revenue", type: "DOUBLE" },
    { table: "teams", name: "team_id", type: "INTEGER" }, { table: "teams", name: "region", type: "VARCHAR" },
    { table: "tickets", name: "ticket_id", type: "INTEGER" }, { table: "tickets", name: "team_id", type: "INTEGER" }, { table: "tickets", name: "resolution_hours", type: "DOUBLE" },
    { table: "sales", name: "sold_on", type: "DATE" }, { table: "orders", name: "ordered_on", type: "DATE" }, { table: "orders", name: "copies", type: "DOUBLE" },
  ];
  const grouped = resolveGeneralSqlPlan("Return region with total revenue and average revenue, ordered alphabetically by region.", repeated);
  assert.deepEqual({ source: grouped?.source, dimensions: grouped?.dimensions, metric: grouped?.aggregates[0]?.field }, { source: "sales", dimensions: ["stores.region"], metric: "sales.revenue" });
  const top = resolveGeneralSqlPlan("Return the top 2 team IDs per region by total resolution_hours, with lower team ID breaking total ties.", repeated);
  assert.deepEqual({ source: top?.source, dimensions: top?.dimensions, partition: top?.windows[0]?.partitionBy }, { source: "tickets", dimensions: ["teams.region", "tickets.team_id"], partition: ["teams.region"] });
  const groupFirst = resolveGeneralSqlPlan("Within each region, return the top 2 team IDs by summed resolution_hours; lower team ID wins ties.", repeated);
  assert.deepEqual({ source: groupFirst?.source, dimensions: groupFirst?.dimensions, partition: groupFirst?.windows[0]?.partitionBy, limit: groupFirst?.qualify[0]?.value }, {
    source: "tickets", dimensions: ["teams.region", "tickets.team_id"], partition: ["teams.region"], limit: 2,
  });
  const lag = resolveGeneralSqlPlan("Show every sale ID with the previous revenue for the same store, ordered by sold_on and sale ID.", repeated);
  assert.deepEqual(lag?.windows[0]?.orderBy, [{ field: "sales.sold_on", direction: "asc" }, { field: "sales.sale_id", direction: "asc" }]);

  const threshold = resolveGeneralSqlPlan("Return store ID and total revenue only for stores whose total revenue is greater than 20, ordered by total revenue descending.", repeated);
  assert.deepEqual({ source: threshold?.source, dimensions: threshold?.dimensions, metric: threshold?.aggregates[0]?.field, having: threshold?.having }, {
    source: "sales", dimensions: ["sales.store_id"], metric: "sales.revenue", having: [{ metric: "metric_1", operator: "gt", value: 20 }],
  });
});

test("treats leading as descending bounded row retrieval rather than model fallback", () => {
  const leading = resolveGeneralSqlPlan("List the leading 2 transaction IDs by amount, using the lower transaction ID for equal values.", schema);
  assert.deepEqual({ source: leading?.source, dimensions: leading?.dimensions, order: leading?.orderBy, limit: leading?.limit }, {
    source: "transactions",
    dimensions: ["transactions.transaction_id", "transactions.amount"],
    order: [{ field: "transactions.amount", direction: "desc" }, { field: "transactions.transaction_id", direction: "asc" }],
    limit: 2,
  });
});

test("normalizes event-relation plurals without confusing moving averages with lag", () => {
  const columns = [
    { table: "plants", name: "plant_id", type: "INTEGER" },
    { table: "batches", name: "batch_id", type: "INTEGER" },
    { table: "batches", name: "plant_id", type: "INTEGER" },
    { table: "batches", name: "produced_on", type: "DATE" },
    { table: "batches", name: "units", type: "DOUBLE" },
  ];
  const running = resolveGeneralSqlPlan("Show batch ID, plant ID, produced_on, units, and the running total of units per plant ordered by produced_on then batch ID.", columns);
  assert.deepEqual({ dimensions: running?.dimensions, fn: running?.windows[0]?.function }, {
    dimensions: ["batches.batch_id", "batches.plant_id", "batches.produced_on", "batches.units"], fn: "running_sum",
  });
  const moving = resolveGeneralSqlPlan("Show batch ID, plant ID, produced_on, units, and the rolling mean of units per plant over the current row and 2 previous rows, ordered by produced_on then batch ID.", columns);
  assert.deepEqual({ fn: moving?.windows[0]?.function, frame: moving?.windows[0]?.frameRows }, { fn: "moving_avg", frame: 2 });

  const ordinaryRunning = resolveGeneralSqlPlan("For each plant, show how units accumulates over time, using date then batch ID for ordering.", columns);
  assert.deepEqual({ fn: ordinaryRunning?.windows[0]?.function, date: ordinaryRunning?.windows[0]?.orderBy[0]?.field }, { fn: "running_sum", date: "batches.produced_on" });
  const ordinaryMoving = resolveGeneralSqlPlan("For each plant, calculate a rolling average units using the current batch and two before it, ordered by date and batch ID.", columns);
  assert.deepEqual({ fn: ordinaryMoving?.windows[0]?.function, frame: ordinaryMoving?.windows[0]?.frameRows }, { fn: "moving_avg", frame: 2 });
  const ordinaryLag = resolveGeneralSqlPlan("Beside every batch, show the previous units for that same plant, in date and ID order.", columns);
  assert.deepEqual({ fn: ordinaryLag?.windows[0]?.function, date: ordinaryLag?.windows[0]?.orderBy[0]?.field }, { fn: "lag", date: "batches.produced_on" });
  const ordinaryShare = resolveGeneralSqlPlan("What share of all units belongs to each plant ID?", columns);
  assert.equal(ordinaryShare?.windows[0]?.function, "share_of_total");
});

test("prefers an explicitly named date field over same-stem timestamps", () => {
  const columns = [
    { table: "projects", name: "project_id", type: "INTEGER" },
    { table: "projects", name: "contractor_id", type: "INTEGER" },
    { table: "projects", name: "started_on", type: "DATE" },
    { table: "projects", name: "started_at", type: "TIMESTAMP" },
    { table: "projects", name: "budget", type: "DOUBLE" },
    { table: "applications", name: "started_at", type: "TIMESTAMP" },
    { table: "applications", name: "fee", type: "DOUBLE" },
  ];
  const lag = resolveGeneralSqlPlan("Show each project ID with the previous budget for the same contractor, ordered by started_on and project ID.", columns);
  assert.deepEqual(lag?.windows[0]?.orderBy, [
    { field: "projects.started_on", direction: "asc" },
    { field: "projects.project_id", direction: "asc" },
  ]);
});

test("general SQL production code contains no holdout domain vocabulary", () => {
  const source = readFileSync(new URL("../lib/general-sql-plan.ts", import.meta.url), "utf8");
  for (const forbidden of ["devices", "readings", "charges", "books", "sales", "genre", "shipment_quotes", "driver_updates"]) {
    assert.doesNotMatch(source, new RegExp(`\\b${forbidden}\\b`, "i"));
  }
});
