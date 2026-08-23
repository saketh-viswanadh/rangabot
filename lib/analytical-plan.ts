import type { ChatMessage } from "./providers/types.ts";
import type { DatasetDescriptor } from "./datasets.ts";
import type { DatasetColumn } from "./sql-runtime.ts";
import { focusDatabaseSchema, type SqlProposal } from "./sql-proposals.ts";
import { validateSqlPreviewQuery } from "./sql-confirmations.ts";

type Aggregate = "count" | "sum" | "avg" | "min" | "max";
type FilterOperator = "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "is_null" | "is_not_null";
type SortDirection = "asc" | "desc";

export type AnalyticalPlan = {
  action: "query" | "clarify" | "unavailable";
  source: string;
  aggregate: Aggregate;
  metric: string;
  alias: string;
  dimensions: string[];
  filters: Array<{ column: string; operator: FilterOperator; value: string }>;
  sort: Array<{ field: string; direction: SortDirection }>;
  limit: number;
  decimals: number;
  explanation: string;
};

const baseAnalyticalPlanSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action", "source", "aggregate", "metric", "alias", "dimensions", "filters", "sort", "limit", "decimals", "explanation"],
  properties: {
    action: { type: "string" }, source: { type: "string" }, aggregate: { type: "string" }, metric: { type: "string" }, alias: { type: "string" },
    dimensions: { type: "array", items: { type: "string" } },
    filters: { type: "array", items: { type: "object", additionalProperties: false, required: ["column", "operator", "value"], properties: { column: { type: "string" }, operator: { type: "string" }, value: { type: "string" } } } },
    sort: { type: "array", items: { type: "object", additionalProperties: false, required: ["field", "direction"], properties: { field: { type: "string" }, direction: { type: "string" } } } },
    limit: { type: "number" }, decimals: { type: "number" }, explanation: { type: "string" },
  },
};

function focusedSchema(messages: ChatMessage[], dataset: DatasetDescriptor, columns: DatasetColumn[]) {
  const request = [...messages].reverse().find((message) => message.role === "user")?.content.trim() ?? "";
  return dataset.format === "duckdb" ? focusDatabaseSchema(columns, request) : columns.map((column) => ({ ...column, table: "dataset" }));
}

export function buildAnalyticalPlanSchema(messages: ChatMessage[], dataset: DatasetDescriptor, columns: DatasetColumn[]) {
  const focused = focusedSchema(messages, dataset, columns);
  const tables = [...new Set(focused.flatMap((column) => column.table ? [column.table] : []))];
  const fields = focused.flatMap((column) => column.table ? [`${column.table}.${column.name}`] : []);
  const schema = structuredClone(baseAnalyticalPlanSchema);
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  properties.action.enum = ["query", "clarify", "unavailable"];
  properties.source.enum = ["", ...tables];
  properties.aggregate.enum = ["", "count", "sum", "avg", "min", "max"];
  properties.metric.enum = ["", "*", ...fields];
  (properties.dimensions.items as Record<string, unknown>).enum = fields;
  const filterProperties = ((properties.filters.items as Record<string, unknown>).properties as Record<string, Record<string, unknown>>);
  filterProperties.column.enum = fields;
  filterProperties.operator.enum = ["eq", "neq", "lt", "lte", "gt", "gte", "is_null", "is_not_null"];
  const sortProperties = ((properties.sort.items as Record<string, unknown>).properties as Record<string, Record<string, unknown>>);
  sortProperties.field.enum = ["__metric__", ...fields];
  sortProperties.direction.enum = ["asc", "desc"];
  return schema;
}

const aggregates = new Set<Aggregate>(["count", "sum", "avg", "min", "max"]);
const operators = new Set<FilterOperator>(["eq", "neq", "lt", "lte", "gt", "gte", "is_null", "is_not_null"]);
const directions = new Set<SortDirection>(["asc", "desc"]);
const safeName = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function reference(value: string) {
  const parts = value.split(".");
  if (parts.length !== 2 || !parts.every((part) => safeName.test(part))) throw new Error(`Invalid analytical field: ${value}`);
  return { table: parts[0], column: parts[1] };
}

export function parseAnalyticalPlan(raw: string): AnalyticalPlan {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("The local model returned an invalid analytical plan.");
  const item = value as Record<string, unknown>;
  if (!(["query", "clarify", "unavailable"] as unknown[]).includes(item.action)
    || typeof item.source !== "string" || typeof item.aggregate !== "string" || typeof item.metric !== "string" || typeof item.alias !== "string"
    || !Array.isArray(item.dimensions) || !Array.isArray(item.filters) || !Array.isArray(item.sort)
    || typeof item.limit !== "number" || typeof item.decimals !== "number" || typeof item.explanation !== "string") {
    throw new Error("The local model returned an incomplete analytical plan.");
  }
  if (item.action !== "query") {
    if (!item.explanation.trim()) throw new Error("The local model returned an unexplained analytical boundary.");
    return { action: item.action as "clarify" | "unavailable", source: "", aggregate: "count", metric: "*", alias: "result", dimensions: [], filters: [], sort: [], limit: 0, decimals: 0, explanation: item.explanation.trim() };
  }
  if (!aggregates.has(item.aggregate as Aggregate) || !safeName.test(item.source)
    || !item.dimensions.every((field) => typeof field === "string")
    || !item.filters.every((filter) => filter && typeof filter === "object" && typeof filter.column === "string" && operators.has(filter.operator) && typeof filter.value === "string")
    || !item.sort.every((sort) => sort && typeof sort === "object" && typeof sort.field === "string" && directions.has(sort.direction))
    || !Number.isInteger(item.limit) || item.limit < 0 || item.limit > 200 || !Number.isInteger(item.decimals) || item.decimals < 0 || item.decimals > 6) {
    throw new Error("The local model returned an unsafe analytical plan.");
  }
  return { ...(item as AnalyticalPlan), alias: safeName.test(item.alias) ? item.alias : "result", explanation: item.explanation.trim() || "Run the requested verified calculation." };
}

function inferMetric(request: string, columns: DatasetColumn[]) {
  const tokens = new Set(request.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const numeric = columns.filter((column) => column.table && /(?:INT|DECIMAL|DOUBLE|REAL|FLOAT|NUMERIC)/i.test(column.type) && !column.name.endsWith("_id"));
  const candidates = numeric.map((column) => {
    let score = column.name.split("_").filter((token) => tokens.has(token)).length * 4;
    return { field: `${column.table}.${column.name}`, score };
  }).sort((left, right) => right.score - left.score || left.field.localeCompare(right.field));
  return candidates[0]?.score > 0 && candidates[0].score > (candidates[1]?.score ?? -1) ? candidates[0].field : null;
}

function inferDimensions(request: string, columns: DatasetColumn[]) {
  const tokens = new Set(request.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const candidates = columns.filter((column) => {
    if (!column.table) return false;
    const parts = column.name.split("_").filter((part) => part.length > 1);
    if (!parts.length) return false;
    if (column.name.endsWith("_id")) return new RegExp(`\\b${parts.slice(0, -1).join("[ _-]+")}[ _-]+(?:id|identifier)\\b`, "i").test(request);
    return parts.every((part) => tokens.has(part));
  });
  const selected = new Map<string, DatasetColumn>();
  for (const column of candidates) {
    const entity = column.name.replace(/_id$/, "");
    const current = selected.get(column.name);
    if (!current || column.table === `${entity}s`) selected.set(column.name, column);
  }
  return [...selected.values()].map((column) => `${column.table}.${column.name}`);
}

function applySemanticFilters(filters: AnalyticalPlan["filters"], request: string, columns: DatasetColumn[]) {
  const availableColumns = columns.filter((column) => column.table);
  const available = new Set(availableColumns.map((column) => `${column.table}.${column.name}`));
  const requestTokens = new Set(request.toLowerCase().match(/[a-z0-9_]+/g) ?? []);
  const nullBoundaryRequested = /\b(?:null|missing|unresolved|without|no )\b/i.test(request);
  const result = filters.filter((filter) => {
    if (!filter.value) return nullBoundaryRequested;
    return available.has(filter.column) && requestTokens.has(filter.value.toLowerCase());
  });
  const set = (column: string, operator: FilterOperator, value = "", exclusive = true) => {
    if (!available.has(column)) return;
    const replacement = { column, operator, value };
    if (exclusive) for (let item = result.length - 1; item >= 0; item -= 1) if (result[item].column === column) result.splice(item, 1);
    const index = result.findIndex((filter) => filter.column === column && filter.operator === operator);
    if (index >= 0) result[index] = replacement; else result.push(replacement);
  };
  for (const column of availableColumns.filter((candidate) => /BOOL/i.test(candidate.type))) {
    const field = `${column.table}.${column.name}`;
    const label = column.name.replace(/^(?:is|has)_/, "").replaceAll("_", " ");
    if (new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(request)) {
      const negated = new RegExp(`\\b(?:not|non|inactive|without|no)\\s+(?:\\w+\\s+){0,2}${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(request);
      set(field, "eq", negated ? "false" : "true");
    }
  }
  const month = request.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(20\d{2})\b/i);
  if (month) {
    const monthIndex = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].indexOf(month[1].toLowerCase());
    const start = `${month[2]}-${String(monthIndex + 1).padStart(2, "0")}-01`;
    const next = new Date(Date.UTC(Number(month[2]), monthIndex + 1, 1)).toISOString().slice(0, 10);
    const dateColumns = availableColumns.filter((column) => /DATE|TIME/i.test(column.type));
    const requestWords = new Set(request.toLowerCase().match(/[a-z0-9]+/g) ?? []);
    const ranked = dateColumns.map((column) => ({
      field: `${column.table}.${column.name}`,
      score: column.name.split("_").filter((token) => requestWords.has(token)).length,
    })).sort((left, right) => right.score - left.score || left.field.localeCompare(right.field));
    const dateField = ranked.length === 1 || (ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 0) ? ranked[0]?.field : undefined;
    if (dateField) { set(dateField, "gte", start, true); set(dateField, "lt", next, false); }
  }
  return result;
}

export function normalizeAnalyticalPlan(plan: AnalyticalPlan, request: string, columns: DatasetColumn[] = []): AnalyticalPlan {
  const boundary = resolveAnalyticalBoundary(request);
  if (boundary) return boundary;
  if (plan.action !== "query") {
    return plan;
  }
  const grouped = /\b(?:by|per|each|breakdown)\b/i.test(request);
  const inferredDimensions = grouped ? inferDimensions(request, columns) : [];
  const dimensions = grouped ? (inferredDimensions.length ? inferredDimensions : plan.dimensions.filter((field) => !field.endsWith("_id") || /\b(?:id|identifier)\b/i.test(request))) : [];
  const filters = applySemanticFilters(plan.filters.filter((filter) => filter.operator === "is_null" || filter.operator === "is_not_null" || filter.value.trim() !== ""), request, columns);
  let sort = /\b(?:top|bottom|highest|lowest|rank|sort|alphabetic|order by)\b/i.test(request) ? plan.sort : [];
  if (/\btop\b/i.test(request)) sort = [{ field: "__metric__", direction: "desc" }];
  if (/\bbottom\b/i.test(request)) sort = [{ field: "__metric__", direction: "asc" }];
  if (/\balphabetic/i.test(request) && dimensions.length) sort = [{ field: dimensions[0], direction: "asc" }];
  const requestedLimit = request.match(/\b(?:top|bottom|first|last)\s+(\d{1,3})\b/i);
  const limit = requestedLimit ? Math.min(200, Number(requestedLimit[1])) : 0;
  const aggregate: Aggregate = /\b(?:average|mean)\b/i.test(request) ? "avg"
    : /\b(?:count|how many)\b/i.test(request) ? "count"
      : /\b(?:total|sum)\b/i.test(request) ? "sum" : plan.aggregate;
  const inferredMetric = aggregate === "count" ? null : inferMetric(request, columns);
  const metric = inferredMetric ?? plan.metric;
  const source = metric !== "*" && metric.includes(".") ? metric.split(".")[0] : plan.source;
  return { ...plan, source, aggregate, metric, dimensions, filters, sort, limit };
}

export function resolveAnalyticalBoundary(request: string): AnalyticalPlan | null {
  const boundary = (action: "clarify" | "unavailable", explanation: string): AnalyticalPlan => ({
    action, source: "", aggregate: "count", metric: "*", alias: "result", dimensions: [], filters: [], sort: [], limit: 0, decimals: 0, explanation,
  });
  if (/\b(?:delete|remove|erase|drop|truncate|update|insert|overwrite|replace|alter|create)\b.{0,120}\b(?:row|rows|record|records|table|database|data|cancelled|pending|completed)\b|\b(?:delete|drop|truncate|update|insert|alter)\s+(?:from|into|table)\b/i.test(request)) {
    return boundary("unavailable", "Analytics is read-only and cannot change or delete the approved dataset.");
  }
  if (/\b(?:prove|show|demonstrate|establish)\b.{0,100}\b(?:cause|causes|caused|causal|causality|because of|leads? to|drives?)\b|\b(?:cause|causes|causal effect|causality)\b/i.test(request)) {
    return boundary("unavailable", "The available observational data cannot establish the requested causal effect.");
  }
  if (/\b(?:pivot|cross[- ]tab)\b/i.test(request)
    && /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(request)
    && !/\b(?:19|20)\d{2}\b/.test(request)) {
    return boundary("clarify", "Which year should the named months use? Add the year so the period boundaries are explicit.");
  }
  const currentDescribesRowOrState = /\bcurrent\s+(?:row|record|event|observation|fact)\b|\bcurrent\s+[a-z][a-z0-9_-]*\s+and\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+before\s+it\b|\bcurrently\s+(?:active|inactive|enabled|disabled|open|closed)\b/i.test(request);
  if (/\b(?:recent|recently|current|currently|latest)\b/i.test(request)
    && !/\b(?:19|20)\d{2}\b|\b(?:today|yesterday|this (?:week|month|quarter|year)|last \d+ (?:days?|weeks?|months?|years?))\b/i.test(request)
    && !/\b(?:latest|newest|most recent)\b.{0,100}\b(?:per|for each|by)\b/i.test(request)
    && !currentDescribesRowOrState) {
    return boundary("clarify", "What exact date, period, or reference time should define “recent” for this analysis?");
  }
  if (/\b(?:best|most valuable|highest-performing|lowest-performing)\b/i.test(request)
    && !/\b(?:by|based on|in terms of|using|measured by)\b.{1,80}\b[\p{L}\p{N}_]+\b/iu.test(request)) {
    return boundary("clarify", "Which measurable field should define that comparison?");
  }
  return null;
}

function quote(name: string) { return `"${name.replaceAll('"', '""')}"`; }

function literal(value: string, type: string) {
  if (/BOOL/i.test(type)) {
    if (!/^(?:true|false)$/i.test(value)) throw new Error(`Invalid Boolean filter value: ${value}`);
    return value.toUpperCase();
  }
  if (/(?:INT|DECIMAL|DOUBLE|REAL|FLOAT|NUMERIC)/i.test(type)) {
    if (!/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error(`Invalid numeric filter value: ${value}`);
    return value;
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function columnMap(columns: DatasetColumn[]) {
  return new Map(columns.filter((column) => column.table).map((column) => [`${column.table}.${column.name}`, column]));
}

function joinGraph(columns: DatasetColumn[]) {
  const tables = [...new Set(columns.flatMap((column) => column.table ? [column.table] : []))];
  const result = new Map<string, Array<{ table: string; key: string }>>();
  for (const left of tables) for (const right of tables) {
    if (left >= right) continue;
    const leftKeys = new Set(columns.filter((column) => column.table === left && column.name.endsWith("_id")).map((column) => column.name));
    const shared = columns.find((column) => column.table === right && leftKeys.has(column.name));
    if (!shared) continue;
    result.set(left, [...(result.get(left) ?? []), { table: right, key: shared.name }]);
    result.set(right, [...(result.get(right) ?? []), { table: left, key: shared.name }]);
  }
  return result;
}

function joinPath(graph: ReturnType<typeof joinGraph>, start: string, target: string) {
  const queue: Array<{ table: string; steps: Array<{ table: string; key: string }> }> = [{ table: start, steps: [] }];
  const visited = new Set([start]);
  while (queue.length) {
    const current = queue.shift()!;
    if (current.table === target) return current.steps;
    for (const edge of graph.get(current.table) ?? []) if (!visited.has(edge.table)) {
      visited.add(edge.table); queue.push({ table: edge.table, steps: [...current.steps, edge] });
    }
  }
  throw new Error(`No approved join path connects ${start} to ${target}.`);
}

export function compileAnalyticalPlan(plan: AnalyticalPlan, columns: DatasetColumn[]): SqlProposal {
  if (plan.action !== "query") return { action: plan.action, query: "", explanation: plan.explanation };
  const available = columnMap(columns);
  const resolve = (field: string) => {
    const ref = reference(field); const column = available.get(field);
    if (!column) throw new Error(`The analytical plan referenced an unavailable field: ${field}`);
    return { ...ref, type: column.type, sql: `${quote(ref.table)}.${quote(ref.column)}` };
  };
  if (!new Set(columns.map((column) => column.table)).has(plan.source)) throw new Error(`The analytical source is unavailable: ${plan.source}`);
  const dimensions = plan.dimensions.map(resolve);
  const metric = plan.metric === "*" ? null : resolve(plan.metric);
  if (plan.metric === "*" && plan.aggregate !== "count") throw new Error("Only count may use the row metric.");
  const filters = plan.filters.map((filter) => ({ ...filter, ref: resolve(filter.column) }));
  const referencedTables = new Set([plan.source, ...dimensions.map((item) => item.table), ...(metric ? [metric.table] : []), ...filters.map((item) => item.ref.table)]);
  const graph = joinGraph(columns); const joined = new Set([plan.source]); const joins: string[] = [];
  for (const target of referencedTables) {
    if (joined.has(target)) continue;
    const start = [...joined].find((table) => { try { joinPath(graph, table, target); return true; } catch { return false; } });
    if (!start) throw new Error(`No approved join path reaches ${target}.`);
    for (const step of joinPath(graph, start, target)) if (!joined.has(step.table)) {
      joins.push(`JOIN ${quote(step.table)} USING (${quote(step.key)})`); joined.add(step.table);
    }
  }
  const operand = metric?.sql ?? "*";
  const aggregated = `${plan.aggregate.toUpperCase()}(${operand})`;
  const expression = plan.decimals > 0 && plan.aggregate !== "count" ? `ROUND(${aggregated}, ${plan.decimals})` : aggregated;
  const selections = [...dimensions.map((item) => item.sql), `${expression} AS ${quote(plan.alias)}`];
  const comparisons: Record<Exclude<FilterOperator, "is_null" | "is_not_null">, string> = { eq: "=", neq: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" };
  const where = filters.map((filter) => filter.operator === "is_null" || filter.operator === "is_not_null"
    ? `${filter.ref.sql} IS ${filter.operator === "is_not_null" ? "NOT " : ""}NULL`
    : `${filter.ref.sql} ${comparisons[filter.operator]} ${literal(filter.value, filter.ref.type)}`);
  const allowedSort = new Set(["__metric__", plan.alias, ...plan.dimensions]);
  const order = plan.sort.map((sort) => {
    if (!allowedSort.has(sort.field)) throw new Error(`The sort field is not selected: ${sort.field}`);
    return `${sort.field === "__metric__" || sort.field === plan.alias ? quote(plan.alias) : resolve(sort.field).sql} ${sort.direction.toUpperCase()}`;
  });
  const query = [`SELECT ${selections.join(", ")}`, `FROM ${quote(plan.source)}`, ...joins, where.length ? `WHERE ${where.join(" AND ")}` : "", dimensions.length ? `GROUP BY ${dimensions.map((item) => item.sql).join(", ")}` : "", order.length ? `ORDER BY ${order.join(", ")}` : "", plan.limit ? `LIMIT ${plan.limit}` : ""].filter(Boolean).join("\n");
  return { action: "query", query: validateSqlPreviewQuery(query), explanation: plan.explanation };
}

export function buildAnalyticalPlanMessages(messages: ChatMessage[], dataset: DatasetDescriptor, columns: DatasetColumn[]): ChatMessage[] {
  const request = [...messages].reverse().find((message) => message.role === "user")?.content.trim() ?? "";
  const focused = focusedSchema(messages, dataset, columns);
  const schema = focused.map((column) => `- ${column.table}.${column.name}: ${column.type}`).join("\n");
  return [
    { role: "system", content: "You are a local analytical intent planner, not a SQL writer. Return only the requested JSON. Every field must be copied exactly from the supplied schema as table.column. Use query only for one simple aggregate: count, sum, avg, min, or max, with optional dimensions, filters, sorting and limit. Use clarify for material ambiguity. Use unavailable when required fields, causal evidence, forecasting, statistics, windows, cohorts, derived formulas, or multiple metrics are needed. Never invent fields or values." },
    { role: "user", content: `REQUEST:\n${request}\n\nSCHEMA:\n${schema}\n\nReturn all fields: action; source table; aggregate; metric (table.column or * only for count); safe alias; dimensions; filters with column, operator and string value; sort using __metric__ or a selected dimension and asc|desc; limit 0-200; decimals 0-6; explanation. Copy enum values exactly. For clarify or unavailable, use empty arrays and explain the exact boundary.` },
  ];
}
