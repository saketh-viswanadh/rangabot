import assert from "node:assert/strict";
import test from "node:test";
import { buildAnalyticalPlanMessages, compileAnalyticalPlan, normalizeAnalyticalPlan, parseAnalyticalPlan } from "../lib/analytical-plan.ts";

const columns = [
  { table: "customers", name: "customer_id", type: "INTEGER" },
  { table: "customers", name: "region", type: "VARCHAR" },
  { table: "customers", name: "is_active", type: "BOOLEAN" },
  { table: "orders", name: "order_id", type: "INTEGER" },
  { table: "orders", name: "customer_id", type: "INTEGER" },
  { table: "orders", name: "status", type: "VARCHAR" },
  { table: "payments", name: "order_id", type: "INTEGER" },
  { table: "payments", name: "amount", type: "DOUBLE" },
  { table: "payments", name: "payment_status", type: "VARCHAR" },
];

test("parses and deterministically compiles a simple aggregate", () => {
  const plan = parseAnalyticalPlan(JSON.stringify({ action: "query", source: "payments", aggregate: "sum", metric: "payments.amount", alias: "paid_revenue", dimensions: [], filters: [{ column: "payments.payment_status", operator: "eq", value: "paid" }], sort: [], limit: 0, decimals: 2, explanation: "Sum successful payments." }));
  assert.equal(compileAnalyticalPlan(plan, columns).query, 'SELECT ROUND(SUM("payments"."amount"), 2) AS "paid_revenue"\nFROM "payments"\nWHERE "payments"."payment_status" = \'paid\'');
});

test("builds verified joins instead of accepting model-authored join SQL", () => {
  const plan = parseAnalyticalPlan(JSON.stringify({ action: "query", source: "payments", aggregate: "sum", metric: "payments.amount", alias: "revenue", dimensions: ["customers.region"], filters: [{ column: "payments.payment_status", operator: "eq", value: "paid" }], sort: [{ field: "revenue", direction: "desc" }], limit: 0, decimals: 2, explanation: "Paid revenue by region." }));
  const query = compileAnalyticalPlan(plan, columns).query;
  assert.match(query, /JOIN "orders" USING \("order_id"\)/);
  assert.match(query, /JOIN "customers" USING \("customer_id"\)/);
  assert.match(query, /GROUP BY "customers"\."region"/);
});

test("rejects invented fields and unsafe values", () => {
  const invented = parseAnalyticalPlan(JSON.stringify({ action: "query", source: "payments", aggregate: "sum", metric: "payments.profit", alias: "profit", dimensions: [], filters: [], sort: [], limit: 0, decimals: 2, explanation: "Profit." }));
  assert.throws(() => compileAnalyticalPlan(invented, columns), /unavailable field/);
  const invalidBoolean = parseAnalyticalPlan(JSON.stringify({ action: "query", source: "customers", aggregate: "count", metric: "*", alias: "customers", dimensions: [], filters: [{ column: "customers.is_active", operator: "eq", value: "yes" }], sort: [], limit: 0, decimals: 0, explanation: "Active customers." }));
  assert.throws(() => compileAnalyticalPlan(invalidBoolean, columns), /Boolean/);
});

test("keeps clarification and unavailable decisions out of SQL", () => {
  const plan = parseAnalyticalPlan(JSON.stringify({ action: "clarify", source: "", aggregate: "", metric: "", alias: "", dimensions: [], filters: [], sort: [], limit: 0, decimals: 0, explanation: "Which measure defines best?" }));
  assert.deepEqual(compileAnalyticalPlan(plan, columns), { action: "clarify", query: "", explanation: "Which measure defines best?" });
});

test("prompts for analytical fields rather than SQL", () => {
  const prompt = buildAnalyticalPlanMessages([{ role: "user", content: "Paid revenue by region" }], { id: "d", name: "shop.duckdb", path: "/private/shop.duckdb", format: "duckdb", sizeBytes: 1, addedAt: "now" }, columns);
  assert.match(prompt[0].content, /not a SQL writer/);
  assert.match(prompt[1].content, /payments\.amount/);
  assert.doesNotMatch(prompt[1].content, /private\/shop/);
});

test("removes model-added grouping, sorting, blank filters, and limits not requested by the user", () => {
  const plan = parseAnalyticalPlan(JSON.stringify({ action: "query", source: "payments", aggregate: "sum", metric: "payments.amount", alias: "*", dimensions: ["payments.payment_status"], filters: [{ column: "payments.payment_status", operator: "eq", value: "paid" }, { column: "payments.payment_method", operator: "eq", value: "" }], sort: [{ field: "__metric__", direction: "desc" }], limit: 200, decimals: 2, explanation: "Revenue." }));
  const normalized = normalizeAnalyticalPlan(plan, "Calculate total successfully paid revenue.", columns);
  assert.deepEqual(normalized.dimensions, []);
  assert.deepEqual(normalized.filters, [{ column: "payments.payment_status", operator: "eq", value: "paid" }]);
  assert.deepEqual(normalized.sort, []);
  assert.equal(normalized.limit, 0);
  assert.equal(normalized.alias, "result");
  assert.equal(normalized.metric, "payments.amount");
  assert.equal(normalized.source, "payments");
  assert.deepEqual(normalized.filters, [{ column: "payments.payment_status", operator: "eq", value: "paid" }]);
});

test("preserves schema-selected metrics and only user-stated filters", () => {
  const base = parseAnalyticalPlan(JSON.stringify({ action: "query", source: "order_items", aggregate: "sum", metric: "order_items.quantity", alias: "result", dimensions: ["orders.order_id"], filters: [{ column: "orders.status", operator: "neq", value: "cancelled" }, { column: "orders.status", operator: "eq", value: "complete" }], sort: [], limit: 200, decimals: 6, explanation: "Units." }));
  const normalized = normalizeAnalyticalPlan(base, "Top 3 product categories by units sold, excluding cancelled orders.", [...columns, { table: "products", name: "category", type: "VARCHAR" }, { table: "order_items", name: "quantity", type: "INTEGER" }]);
  assert.equal(normalized.aggregate, "sum");
  assert.equal(normalized.metric, "order_items.quantity");
  assert.deepEqual(normalized.dimensions, []);
  assert.deepEqual(normalized.filters, [{ column: "orders.status", operator: "neq", value: "cancelled" }]);
  assert.equal(normalized.limit, 3);
});

test("turns ambiguous superlatives into a dataset-focused clarification", () => {
  const query = parseAnalyticalPlan(JSON.stringify({ action: "query", source: "customers", aggregate: "sum", metric: "*", alias: "result", dimensions: [], filters: [], sort: [], limit: 0, decimals: 0, explanation: "Best region." }));
  const normalized = normalizeAnalyticalPlan(query, "Which region is best?", columns);
  assert.equal(normalized.action, "clarify");
  assert.equal(normalized.explanation, "Which measurable field should define that comparison?");
});

test("selects one canonical requested identifier and ranks top results by the metric", () => {
  const schema = [...columns, { table: "returns", name: "return_id", type: "INTEGER" }, { table: "returns", name: "customer_id", type: "INTEGER" }];
  const plan = parseAnalyticalPlan(JSON.stringify({ action: "query", source: "payments", aggregate: "sum", metric: "payments.amount", alias: "revenue", dimensions: ["returns.return_id", "orders.customer_id"], filters: [], sort: [{ field: "orders.customer_id", direction: "asc" }], limit: 99, decimals: 2, explanation: "Top customers." }));
  const normalized = normalizeAnalyticalPlan(plan, "Who are the top 5 customers by paid revenue? Return customer ID and revenue.", schema);
  assert.deepEqual(normalized.dimensions, ["customers.customer_id"]);
  assert.deepEqual(normalized.sort, [{ field: "__metric__", direction: "desc" }]);
  assert.equal(normalized.limit, 5);
});
