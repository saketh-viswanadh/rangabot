import type { ChatMessage } from "./providers/types.ts";
import type { ApprovedDataset } from "./datasets.ts";
import type { DatasetColumn } from "./sql-runtime.ts";
import { validateSqlPreviewQuery } from "./sql-confirmations.ts";

export type SqlProposal = { action: "query" | "clarify" | "unavailable"; query: string; explanation: string };

export const sqlProposalSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action", "query", "explanation"],
  properties: {
    action: { type: "string" },
    query: { type: "string" },
    explanation: { type: "string" },
  },
};

const schemaStopWords = new Set(["a", "an", "and", "as", "at", "by", "for", "from", "in", "is", "of", "on", "or", "the", "to", "was", "were", "with"]);
function schemaTokens(value: string) {
  return new Set(value.toLowerCase().match(/[a-z0-9]+/g)?.map((token) => token.length > 4 && token.endsWith("s") ? token.slice(0, -1) : token).filter((token) => token.length > 2 && !schemaStopWords.has(token)) ?? []);
}

const schemaConcepts: Array<{ request: RegExp; columns: RegExp }> = [
  { request: /\b(?:revenue|sales|paid|order value)\b/i, columns: /\b(?:amount|payment_status|unit_price|discount_pct)\b/i },
  { request: /\b(?:units?|items?|quantity)\b/i, columns: /\bquantity\b/i },
  { request: /\b(?:margin|cost|profit)\b/i, columns: /\b(?:unit_cost|unit_price|discount_pct|quantity)\b/i },
  { request: /\b(?:active|inactive)\b/i, columns: /\bis_active\b/i },
  { request: /\b(?:refund|returned?|return rate)\b/i, columns: /\b(?:status|payment_status|return_quantity|return_reason|return_date)\b/i },
  { request: /\b(?:support|tickets?|resolution|satisfaction)\b/i, columns: /\b(?:created_at|resolved_at|priority|satisfaction_score)\b/i },
  { request: /\b(?:signup|acquisition|cohort)\b/i, columns: /\b(?:signup_date|acquisition_channel)\b/i },
];

export function focusDatabaseSchema(columns: DatasetColumn[], request: string): DatasetColumn[] {
  if (!columns.some((column) => column.table)) return columns;
  const byTable = new Map<string, DatasetColumn[]>();
  for (const column of columns) {
    if (!column.table) continue;
    byTable.set(column.table, [...(byTable.get(column.table) ?? []), column]);
  }
  const requestTokens = schemaTokens(request);
  const scores = [...byTable].map(([table, tableColumns]) => {
    let score = [...schemaTokens(table)].filter((token) => requestTokens.has(token)).length * 5;
    for (const column of tableColumns) {
      if (column.name.endsWith("_id")) continue;
      score += [...schemaTokens(column.name)].filter((token) => requestTokens.has(token)).length * 2;
    }
    for (const concept of schemaConcepts) if (concept.request.test(request) && tableColumns.some((column) => concept.columns.test(column.name))) score += 2;
    return { table, score };
  }).sort((a, b) => b.score - a.score || a.table.localeCompare(b.table));
  const selected = new Set(scores.filter((item) => item.score > 0).slice(0, 6).map((item) => item.table));
  if (!selected.size) return columns;

  const neighbors = new Map<string, Set<string>>();
  for (const [left, leftColumns] of byTable) for (const [right, rightColumns] of byTable) {
    if (left >= right) continue;
    const rightNames = new Set(rightColumns.map((column) => column.name));
    if (leftColumns.some((column) => column.name.endsWith("_id") && rightNames.has(column.name))) {
      neighbors.set(left, new Set([...(neighbors.get(left) ?? []), right]));
      neighbors.set(right, new Set([...(neighbors.get(right) ?? []), left]));
    }
  }
  const selectedList = [...selected];
  for (let index = 0; index < selectedList.length; index += 1) for (let targetIndex = index + 1; targetIndex < selectedList.length; targetIndex += 1) {
    const start = selectedList[index]; const target = selectedList[targetIndex];
    const queue: Array<{ table: string; path: string[] }> = [{ table: start, path: [start] }];
    const visited = new Set([start]);
    while (queue.length) {
      const current = queue.shift()!;
      if (current.table === target) { for (const table of current.path) selected.add(table); break; }
      for (const neighbor of neighbors.get(current.table) ?? []) if (!visited.has(neighbor)) { visited.add(neighbor); queue.push({ table: neighbor, path: [...current.path, neighbor] }); }
    }
  }
  return columns.filter((column) => column.table && selected.has(column.table));
}

export function parseSqlProposal(raw: string): SqlProposal {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("The local model returned an invalid SQL proposal.");
  const candidate = value as Record<string, unknown>;
  if ((candidate.action !== "query" && candidate.action !== "clarify" && candidate.action !== "unavailable")
    || typeof candidate.query !== "string" || candidate.query.length > 2_000
    || typeof candidate.explanation !== "string" || !candidate.explanation.trim() || candidate.explanation.length > 500) {
    throw new Error("The local model returned an incomplete SQL proposal.");
  }
  if (candidate.action !== "query") {
    if (candidate.query.trim()) throw new Error("A non-query SQL decision must not include SQL.");
    return { action: candidate.action, query: "", explanation: candidate.explanation.trim() };
  }
  return { action: "query", query: validateSqlPreviewQuery(candidate.query), explanation: candidate.explanation.trim() };
}

export function buildSqlProposalMessages(messages: ChatMessage[], dataset: ApprovedDataset, columns: DatasetColumn[]): ChatMessage[] {
  const request = [...messages].reverse().find((message) => message.role === "user")?.content.trim() ?? "";
  const focusedColumns = dataset.format === "duckdb" ? focusDatabaseSchema(columns, request) : columns;
  const schema = focusedColumns.map((column) => `- ${column.table ? `${JSON.stringify(column.table)}.` : ""}${JSON.stringify(column.name)}: ${column.type}`).join("\n");
  const joinKeys = [...new Set(focusedColumns.filter((column) => column.table && column.name.endsWith("_id")).flatMap((column, _index, all) => all.some((other) => other.table !== column.table && other.name === column.name) ? [column.name] : []))];
  const relationBoundary = dataset.format === "duckdb"
    ? `Use only the focused main-schema tables and columns. Join them only through columns present in the schema. Shared join keys: ${joinKeys.length ? joinKeys.join(", ") : "none"}. Before returning, verify every referenced table appears in FROM or JOIN, every requested count/aggregate is present, filters use the correct typed column, and GROUP BY matches only the requested grain.`
    : "The only available relation is dataset. Use only listed columns.";
  return [
    { role: "system", content: `You are Rangabot's local SQL planner. Decide whether to query, clarify, or explain that required data is unavailable. ${relationBoundary} Use action query only when the request has one materially clear interpretation and the listed schema can answer it. For query, produce one DuckDB SELECT. Use clarify when a missing definition or choice could materially change the answer. Use unavailable when required fields, causal evidence, history, or comparison data do not exist. Never invent data, results, columns, tables, files, or external access. Do not use ATTACH, COPY, CREATE, DELETE, DROP, EXPORT, INSTALL, LOAD, PRAGMA, SET, UPDATE, INSERT, CALL, ALTER, VACUUM, or multiple statements.` },
    { role: "user", content: `USER REQUEST:\n${request}\n\nAPPROVED LOCAL DATASET:\n${dataset.name} (${dataset.format})\n\nSCHEMA:\n${schema}\n\nReturn {"action":"query|clarify|unavailable","query":"...","explanation":"..."}. For clarify or unavailable, query must be an empty string and explanation must directly ask the one needed question or state the exact data/evidence boundary. For query, explanation describes the calculation without claiming results.` },
  ];
}
