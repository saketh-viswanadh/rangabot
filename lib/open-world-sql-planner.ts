import { createHash } from "node:crypto";
import type { ChatMessage } from "./providers/types.ts";
import type { DatasetColumn, SqlExecutionResult } from "./sql-runtime.ts";
import { validateSqlPreviewQuery } from "./sql-confirmations.ts";

export const OPEN_WORLD_SQL_PLANNER_VERSION = "1.0.0" as const;
const maximumFocusedColumns = 120;
const maximumGroundedTextColumns = 64;
const maximumValueMatches = 80;
const maximumCandidates = 3;

type CandidateDocument = {
  decision: "query" | "clarify" | "unavailable";
  candidates: Array<{ query: string; explanation: string }>;
  explanation: string;
};

export type GroundedSchemaValue = { field: string; value: string };
export type OpenWorldSqlAttempt = {
  query: string;
  explanation: string;
  source: "compiler" | "typed" | "model" | "repair";
  status: "success" | "invalid" | "execution-error";
  score: number;
  error?: string;
  execution?: SqlExecutionResult;
};

export type OpenWorldSqlPlan = {
  version: typeof OPEN_WORLD_SQL_PLANNER_VERSION;
  action: "query" | "clarify" | "unavailable";
  explanation: string;
  focusedFields: string[];
  groundedValues: GroundedSchemaValue[];
  attempts: OpenWorldSqlAttempt[];
  selected?: OpenWorldSqlAttempt & { execution: SqlExecutionResult };
};

export type OpenWorldSqlDependencies = {
  completeJson(messages: ChatMessage[], options: { jsonSchema: Record<string, unknown>; numPredict: number; modelId: string; temperature: number; seed: number; signal?: AbortSignal }): Promise<string>;
  executeSql(query: string): Promise<SqlExecutionResult>;
};

const stopWords = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "did", "do", "does", "each", "for", "from", "give", "how", "in", "is", "it", "list", "of", "on", "or", "show", "that", "the", "their", "to", "was", "were", "what", "which", "with",
]);

function words(value: string) {
  const aliases: Record<string, string> = {
    amt: "amount", avg: "average", dob: "birth", heavier: "weight", heavy: "weight", indep: "independent",
    create: "created", death: "killed", directed: "director", established: "year", first: "1", founded: "year", ids: "id", injury: "injured", lighter: "weight", num: "number", oldest: "age", older: "age", opened: "open", opening: "open", phone: "number", postal: "zip", postcode: "zip", qty: "quantity",
    second: "2", third: "3", title: "name", weigh: "weight", weighs: "weight", youngest: "age", younger: "age", yr: "year",
  };
  return (value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().replaceAll("_", " ").match(/[a-z0-9]+/g) ?? []).map((token) => {
    if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
    if (token.length > 4 && /(?:ches|shes|xes|zes|sses)$/.test(token)) return token.slice(0, -2);
    const normalized = token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token;
    return aliases[normalized] ?? normalized;
  }).filter((token) => (token.length > 1 || /^\d+$/.test(token)) && !stopWords.has(token));
}

function quoteIdentifier(value: string) { return `"${value.replaceAll('"', '""')}"`; }
function quoteLiteral(value: string) { return `'${value.replaceAll("'", "''")}'`; }
function field(column: DatasetColumn) { return column.table ? `${column.table}.${column.name}` : column.name; }
function textColumn(column: DatasetColumn) { return /CHAR|TEXT|STRING|VARCHAR|ENUM/i.test(column.type); }
function columnMeaningTokens(column: DatasetColumn) {
  const original = words([column.name, column.semantic?.description ?? "", ...(column.semantic?.aliases ?? [])].join(" "));
  const tableTokens = new Set(words(column.table ?? ""));
  const specific = original.filter((token) => !tableTokens.has(token));
  return specific.length ? specific : original;
}

function valueMentioned(request: string, value: string) {
  const normalizedRequest = request.toLowerCase();
  const normalizedValue = value.trim().toLowerCase();
  if (!normalizedValue || normalizedValue.length > 120) return false;
  const quoted = [...request.matchAll(/["']([^"']+)["']/g)].map((match) => match[1].trim().toLowerCase());
  if (quoted.includes(normalizedValue)) return true;
  if (normalizedValue.length < 2) return false;
  if (stopWords.has(normalizedValue)) return false;
  const escaped = normalizedValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (value.length <= 3 && /^[A-Z0-9]+$/.test(value)) return new RegExp(`(?:^|[^A-Za-z0-9])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^A-Za-z0-9])`).test(request);
  const valueTokens = words(value);
  if (valueTokens.length === 1 && valueTokens[0].length >= 5 && words(request).includes(valueTokens[0])) return true;
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(normalizedRequest);
}

function lexicalScore(requestTokens: Set<string>, column: DatasetColumn) {
  const tableTokens = words([column.table ?? "", column.semantic?.tableDescription ?? "", ...(column.semantic?.tableAliases ?? [])].join(" "));
  const columnTokens = words([column.name, column.semantic?.description ?? "", ...(column.semantic?.aliases ?? [])].join(" "));
  const tableOverlap = tableTokens.filter((token) => requestTokens.has(token)).length;
  const columnOverlap = columnTokens.filter((token) => requestTokens.has(token)).length;
  const exactColumn = columnTokens.length > 0 && columnTokens.every((token) => requestTokens.has(token));
  const identifier = /(?:^|_)id$/i.test(column.name) ? 1 : 0;
  return tableOverlap * 12 + columnOverlap * 8 + (exactColumn ? 12 : 0) + identifier;
}

function inferredRelationships(columns: DatasetColumn[]) {
  const declared = columns.flatMap((column) => (column.table && column.references)
    ? column.references.map((reference) => `${column.table}.${column.name} = ${reference.table}.${reference.column} [DECLARED FOREIGN KEY]`)
    : []);
  const tables = [...new Set(columns.flatMap((column) => column.table ? [column.table] : []))];
  const byTable = new Map(tables.map((table) => [table, columns.filter((column) => column.table === table)]));
  const relationships: string[] = [];
  for (let leftIndex = 0; leftIndex < tables.length; leftIndex += 1) for (let rightIndex = leftIndex + 1; rightIndex < tables.length; rightIndex += 1) {
    const left = tables[leftIndex]; const right = tables[rightIndex];
    const rightNames = new Map((byTable.get(right) ?? []).map((column) => [column.name.toLowerCase(), column]));
    for (const leftColumn of byTable.get(left) ?? []) {
      const rightColumn = rightNames.get(leftColumn.name.toLowerCase());
      if (!rightColumn) continue;
      const name = leftColumn.name.toLowerCase();
      if (!(name === "id" || name.endsWith("_id") || name.endsWith("_code") || name.endsWith("_key") || name.endsWith("_number"))) continue;
      relationships.push(`${left}.${leftColumn.name} = ${right}.${rightColumn.name}`);
    }
  }
  return [...new Set([...declared, ...relationships])].slice(0, 120);
}

function focusedColumns(columns: DatasetColumn[], request: string, groundedValues: GroundedSchemaValue[] = []) {
  if (!columns.some((column) => column.table)) return columns.slice(0, maximumFocusedColumns);
  const requestTokens = new Set(words(request));
  const grounded = new Set(groundedValues.map((match) => match.field));
  const ranked = columns.map((column, index) => ({
    column,
    index,
    score: lexicalScore(requestTokens, column) + (grounded.has(field(column)) ? 40 : 0),
  })).sort((left, right) => right.score - left.score || left.index - right.index);
  const selectedTables = new Set(ranked.filter((item) => item.score > 0).slice(0, 10).flatMap((item) => item.column.table ? [item.column.table] : []));
  if (!selectedTables.size) return columns.slice(0, maximumFocusedColumns);
  const relationships = inferredRelationships(columns);
  let changed = true;
  while (changed && selectedTables.size < 14) {
    changed = false;
    for (const relation of relationships) {
      const match = relation.match(/^([^.]+)\.[^ ]+ = ([^.]+)\./);
      if (!match) continue;
      const left = match[1]; const right = match[2];
      if (selectedTables.has(left) !== selectedTables.has(right)) {
        selectedTables.add(left); selectedTables.add(right); changed = true;
      }
      if (selectedTables.size >= 14) break;
    }
  }
  const selected = columns.filter((column) => column.table && selectedTables.has(column.table));
  return selected.length <= maximumFocusedColumns ? selected : ranked.filter((item) => selectedTables.has(item.column.table ?? "")).slice(0, maximumFocusedColumns).map((item) => item.column);
}

export async function groundQuestionValues(request: string, columns: DatasetColumn[], executeSql: (query: string) => Promise<SqlExecutionResult>): Promise<GroundedSchemaValue[]> {
  const requestTokens = new Set(words(request));
  const candidates = columns.filter((column) => column.table && textColumn(column)).map((column, index) => ({ column, index, score: lexicalScore(requestTokens, column) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, maximumGroundedTextColumns)
    .map((item) => item.column);
  if (!candidates.length) return [];
  const requestLiteral = quoteLiteral(request);
  const query = candidates.map((column) => {
    const table = quoteIdentifier(column.table!); const name = quoteIdentifier(column.name); const qualified = `${table}.${name}`;
    return `SELECT ${quoteLiteral(field(column))} AS "field", CAST(${qualified} AS VARCHAR) AS "value" FROM ${table} WHERE ${qualified} IS NOT NULL AND LENGTH(CAST(${qualified} AS VARCHAR)) BETWEEN 1 AND 120 AND STRPOS(LOWER(${requestLiteral}), LOWER(CAST(${qualified} AS VARCHAR))) > 0 GROUP BY ${qualified}`;
  }).join("\nUNION ALL\n");
  if (query.length > 19_500) return [];
  try {
    const result = await executeSql(query);
    if (result.receipt.truncated) return [];
    const matches = result.rows.flatMap((row) => typeof row[0] === "string" && typeof row[1] === "string" && valueMentioned(request, row[1]) ? [{ field: row[0], value: row[1] }] : []);
    return matches.slice(0, maximumValueMatches);
  } catch {
    return [];
  }
}

function schemaText(columns: DatasetColumn[], relationships: string[], values: GroundedSchemaValue[]) {
  const byTable = new Map<string, DatasetColumn[]>();
  for (const column of columns) {
    const table = column.table ?? "dataset";
    byTable.set(table, [...(byTable.get(table) ?? []), column]);
  }
  const tables = [...byTable].map(([table, tableColumns]) => `TABLE ${JSON.stringify(table)}\n${tableColumns.map((column) => {
    const annotations = [
      column.primaryKey ? "PRIMARY KEY" : "",
      ...(column.references ?? []).map((reference) => `FOREIGN KEY -> ${reference.table}.${reference.column}`),
    ].filter(Boolean);
    const meanings = [
      ...(column.semantic?.aliases?.length ? [`aliases=${JSON.stringify(column.semantic.aliases)}`] : []),
      ...(column.semantic?.description ? [`meaning=${JSON.stringify(column.semantic.description)}`] : []),
    ];
    return `  - ${JSON.stringify(column.name)} ${column.type}${annotations.length || meanings.length ? ` [${[...annotations, ...meanings].join("; ")}]` : ""}`;
  }).join("\n")}`).join("\n\n");
  const relationText = relationships.length ? `\n\nINFERRED JOIN CANDIDATES (verify semantics; do not join on similarity alone):\n${relationships.map((relation) => `- ${relation}`).join("\n")}` : "";
  const valueText = values.length ? `\n\nQUESTION-MATCHED DATABASE VALUES:\n${values.map((match) => `- ${match.field} = ${JSON.stringify(match.value)}`).join("\n")}` : "";
  return `${tables}${relationText}${valueText}`;
}

export const openWorldSqlCandidateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "candidates", "explanation"],
  properties: {
    decision: { type: "string", enum: ["query", "clarify", "unavailable"] },
    candidates: {
      type: "array", minItems: 0, maxItems: maximumCandidates,
      items: {
        type: "object", additionalProperties: false, required: ["query", "explanation"],
        properties: { query: { type: "string" }, explanation: { type: "string" } },
      },
    },
    explanation: { type: "string" },
  },
} as const;

function parseDocument(raw: string): CandidateDocument {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The open-world SQL planner returned an invalid document.");
  const item = parsed as Record<string, unknown>;
  if (!(["query", "clarify", "unavailable"] as unknown[]).includes(item.decision) || !Array.isArray(item.candidates) || item.candidates.length > maximumCandidates || typeof item.explanation !== "string") throw new Error("The open-world SQL planner returned an incomplete document.");
  const candidates = item.candidates.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("The open-world SQL planner returned an invalid candidate.");
    const value = candidate as Record<string, unknown>;
    if (typeof value.query !== "string" || value.query.length > 20_000 || typeof value.explanation !== "string") throw new Error("The open-world SQL planner returned an invalid candidate.");
    return { query: value.query, explanation: value.explanation.trim().slice(0, 600) };
  });
  const usableCandidates = candidates.filter((candidate) => candidate.query.trim());
  const effectiveDecision = usableCandidates.length ? "query" : item.decision === "query" ? "clarify" : item.decision;
  return { decision: effectiveDecision as CandidateDocument["decision"], candidates: usableCandidates, explanation: item.explanation.trim().slice(0, 600) || "The request could not be mapped safely to the approved schema." };
}

function resultFingerprint(result: SqlExecutionResult) {
  return createHash("sha256").update(JSON.stringify({ columns: result.columns, rows: result.rows, truncated: result.receipt.truncated })).digest("hex");
}

function semanticScore(request: string, query: string, source: OpenWorldSqlAttempt["source"], candidateIndex: number) {
  const normalized = query.toLowerCase();
  let score = source === "compiler" ? 12 : source === "typed" ? 8 : source === "repair" ? 3 : Math.max(1, 6 - candidateIndex);
  if (!/select\s+\*/i.test(query)) score += 3;
  if (/\b(?:highest|lowest|top|bottom|most|least|oldest|youngest)\b/i.test(request) && /\border\s+by\b/i.test(query)) score += 3;
  if (/\b(?:how many|count|number of)\b/i.test(request) && /\bcount\s*\(/i.test(query)) score += 3;
  if (/\b(?:total|sum)\b/i.test(request) && /\bsum\s*\(/i.test(query)) score += 3;
  if (/\b(?:average|mean)\b/i.test(request) && /\bavg\s*\(/i.test(query)) score += 3;
  if (/\b(?:different|distinct|unique)\b/i.test(request) && /\bdistinct\b/i.test(query)) score += 2;
  score -= (query.match(/\bjoin\b/gi)?.length ?? 0) * 5;
  for (const token of new Set(words(request))) if (token.length >= 4 && normalized.includes(token)) score += 0.25;
  return score;
}

function semanticViolation(request: string, query: string) {
  if (/\blimit\b/i.test(query) && !/\b(?:bottom|highest|last\s+\d+|least|lowest|most|oldest|top|youngest)\b|\bfirst\s+\d+\b|\blimit\b/i.test(request)) {
    return "The query invented a result limit that the request did not ask for.";
  }
  if (/\byoungest\b/i.test(request) && (!/\border\s+by\b/i.test(query) || !/\blimit\s+1\b/i.test(query) || /\border\s+by\b[^;]*\bdesc\b/i.test(query))) return "The query did not implement the youngest-row superlative.";
  if (/\boldest\b/i.test(request) && (!/\border\s+by\b/i.test(query) || !/\blimit\s+1\b/i.test(query) || !/\border\s+by\b[^;]*\bdesc\b/i.test(query))) return "The query did not implement the oldest-row superlative.";
  if (/\bdescending\b|\bhigh\s+to\s+low\b|\bold\s+to\s+young\b/i.test(request) && !/\border\s+by\b[^;]*\bdesc\b/i.test(query)) return "The query did not preserve the requested descending order.";
  if (/\b(?:either|or)\b/i.test(request) && !/\b(?:or|union)\b|\bin\s*\(/i.test(query)) return "The query omitted an explicit alternative in the request.";
  if (/\b(?:not|except|excluding|other than)\b/i.test(request) && !/(?:!=|<>|\bnot\b|\bexcept\b)/i.test(query)) return "The query omitted the requested exclusion.";
  return null;
}

function tableCandidates(columns: DatasetColumn[], request: string) {
  const requestTokens = new Set(words(request));
  const collapsedRequest = words(request).join("");
  const tables = [...new Set(columns.flatMap((column) => column.table ? [column.table] : []))];
  return tables.map((table) => {
    const tokens = words(table);
    const lexicalOverlap = tokens.filter((token) => requestTokens.has(token)).length;
    const compoundMatch = tokens.length > 0 && collapsedRequest.includes(tokens.join(""));
    const overlap = compoundMatch ? Math.max(1, tokens.length, lexicalOverlap) : lexicalOverlap;
    return { table, overlap, coverage: overlap / Math.max(1, tokens.length) };
  }).filter((item) => item.overlap > 0).sort((left, right) => right.overlap - left.overlap || right.coverage - left.coverage || left.table.localeCompare(right.table));
}

function uniquelyRelevantTable(columns: DatasetColumn[], request: string) {
  const ranked = tableCandidates(columns, request);
  if (!ranked[0]) return null;
  if (ranked[1] && ranked[0].overlap === ranked[1].overlap && ranked[0].coverage === ranked[1].coverage) return null;
  return ranked[0].table;
}

function uniquelyRelevantTableByColumns(columns: DatasetColumn[], request: string) {
  const requestTokens = new Set(words(request));
  const ranked = [...new Set(columns.flatMap((column) => column.table ? [column.table] : []))].map((table) => {
    const matches = columns.filter((column) => column.table === table).map((column) => {
      const tokens = words(column.name);
      const overlap = tokens.filter((token) => requestTokens.has(token)).length;
      return { overlap, exact: tokens.length > 0 && overlap === tokens.length };
    }).filter((item) => item.overlap > 0);
    return { table, matchedColumns: matches.length, score: matches.reduce((sum, item) => sum + item.overlap + (item.exact ? 2 : 0), 0) };
  }).filter((item) => item.matchedColumns >= 2).sort((left, right) => right.score - left.score || right.matchedColumns - left.matchedColumns || left.table.localeCompare(right.table));
  if (!ranked[0] || (ranked[1] && ranked[0].score === ranked[1].score && ranked[0].matchedColumns === ranked[1].matchedColumns)) return null;
  return ranked[0].table;
}

function requestBeforeOrdering(request: string) {
  const marker = request.search(/\b(?:ascending|descending|ordered|order|sort|sorted)\b/i);
  return marker >= 0 ? request.slice(0, marker) : request;
}

function numericLiteral(request: string) {
  const numeric = request.match(/-?\d+(?:\.\d+)?/);
  if (numeric) return numeric[0];
  const names: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10" };
  const named = request.toLowerCase().match(/\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\b/)?.[0];
  return named ? names[named] : null;
}

function numericTokenValue(value: string) {
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return value;
  const names: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10" };
  return names[value.toLowerCase()] ?? null;
}

function isCountRequest(request: string) {
  const normalized = request.trim();
  return /\b(?:how many|count(?: the number)? of|count the number of|total count of|total number of)\b/i.test(normalized)
    || /^(?:(?:find|give|list|return|show|what is|what's)\s+)?(?:the\s+)?number of\b/i.test(normalized);
}

function numericFilter(request: string, columns: DatasetColumn[]) {
  const semanticRequest = requestBeforeOrdering(request);
  const number = numericLiteral(semanticRequest);
  if (!number) return null;
  const requestTokens = new Set(words(semanticRequest));
  const lower = semanticRequest.toLowerCase();
  const numberIndex = lower.search(/-?\d+(?:\.\d+)?|\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\b/);
  const relationHints = /\b(?:heavier|lighter|weigh|weight)\b/.test(lower) ? new Set(["weight"])
    : /\b(?:older|younger|age)\b/.test(lower) ? new Set(["age"])
      : /\b(?:after|before|date|year)\b/.test(lower) ? new Set(["date", "year"])
        : new Set<string>();
  const ranked = columns.filter((column) => /INT|DECIMAL|DOUBLE|FLOAT|HUGEINT|NUMERIC|REAL/i.test(column.type)).map((column) => {
    const tokens = words(column.name);
    const overlap = tokens.filter((token) => requestTokens.has(token)).length;
    const score = overlap + tokens.filter((token) => relationHints.has(token)).length * 3;
    const positions = tokens.map((token) => lower.lastIndexOf(token, numberIndex >= 0 ? numberIndex : undefined)).filter((index) => index >= 0);
    const proximity = positions.length && numberIndex >= 0 ? numberIndex - Math.max(...positions) : Number.MAX_SAFE_INTEGER;
    return { column, overlap, score, proximity };
  }).filter((item) => item.score > 0).sort((left, right) => right.score - left.score || left.proximity - right.proximity || right.overlap - left.overlap || left.column.name.localeCompare(right.column.name));
  if (!ranked[0] || (ranked[1] && ranked[0].score === ranked[1].score && ranked[0].proximity === ranked[1].proximity)) return null;
  const operator = /\b(?:after|above|greater|heavier|higher|more|older|over)\b/.test(lower) ? ">"
    : /\b(?:before|below|fewer|less|lighter|lower|under|younger)\b/.test(lower) ? "<"
      : /\b(?:at least|no fewer than)\b/.test(lower) ? ">="
        : /\b(?:at most|no more than)\b/.test(lower) ? "<=" : null;
  return operator ? { column: ranked[0].column, operator, value: number } : null;
}

function phraseIndex(haystack: string[], needle: string[]) {
  if (!needle.length || needle.length > haystack.length) return -1;
  for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    if (needle.every((token, offset) => haystack[index + offset] === token)) return index;
  }
  return -1;
}

function requestedOrder(request: string, columns: DatasetColumn[], fallback?: DatasetColumn) {
  const marker = request.search(/\b(?:ascending|descending|ordered|order|sort|sorted)\b/i);
  const superlative = request.match(/\b(?:highest|lowest|most|least|oldest|youngest)\b/i)?.[0].toLowerCase();
  if (marker < 0 && !superlative && !/\balphabetical/i.test(request)) return null;
  const superlativeIndex = superlative ? request.toLowerCase().indexOf(superlative) : -1;
  const orderText = marker >= 0 ? request.slice(marker) : superlativeIndex >= 0 ? request.slice(superlativeIndex) : request;
  const orderTokens = words(orderText);
  const ranked = columns.map((column) => {
    const tokens = columnMeaningTokens(column);
    const overlap = tokens.filter((token) => orderTokens.includes(token)).length;
    return { column, overlap, coverage: overlap / Math.max(1, tokens.length) };
  }).filter((item) => item.overlap > 0).sort((left, right) => right.coverage - left.coverage || right.overlap - left.overlap || left.column.name.localeCompare(right.column.name));
  const selected = superlative && /oldest|youngest/.test(superlative) ? columns.find((column) => columnMeaningTokens(column).includes("age"))
    : superlative && ranked[0] ? ranked[0].column
    : ranked[0] && (ranked[0].coverage === 1 || (marker >= 0 && (!ranked[1] || ranked[0].overlap > ranked[1].overlap))) ? ranked[0].column
      : /alphabetical/i.test(request) ? fallback : null;
  if (!selected) return null;
  const direction = /\b(?:descending|highest|most|oldest)\b|\b(?:high|old)\s+to\s+(?:low|young)\b/i.test(request) ? "DESC" : "ASC";
  return { column: selected, direction, limit: Boolean(superlative) };
}

function groundedFilterSql(request: string, table: string, columns: DatasetColumn[], values: GroundedSchemaValue[]) {
  const requestTokens = new Set(words(request));
  const groups = new Map<string, GroundedSchemaValue[]>();
  for (const match of values.filter((item) => item.field.startsWith(`${table}.`) && columns.some((column) => field(column) === item.field))) {
    groups.set(match.field, [...(groups.get(match.field) ?? []), match]);
  }
  const ranked = [...groups].map(([fieldName, matches]) => {
    const column = columns.find((item) => field(item) === fieldName)!;
    return { column, matches, overlap: columnMeaningTokens(column).filter((token) => requestTokens.has(token)).length };
  }).sort((left, right) => right.overlap - left.overlap || Math.max(...right.matches.map((item) => item.value.length)) - Math.max(...left.matches.map((item) => item.value.length)) || left.column.name.localeCompare(right.column.name));
  if (!ranked[0]) return { expressions: [] as string[], usedFields: new Set<string>() };
  const selected = ranked[0];
  const uniqueValues = [...new Map(selected.matches.map((item) => [item.value.toLocaleLowerCase("en-US"), item.value])).values()];
  const columnSql = quoteIdentifier(selected.column.name);
  const negated = /\b(?:not|except|excluding|other than)\b/i.test(request);
  const substring = /\b(?:contain|contains|containing|include|includes|including)\b/i.test(request)
    || uniqueValues.some((value) => new RegExp(`\\bletter\\s+["']?${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?`, "i").test(request));
  let expression: string;
  if (substring && uniqueValues.length === 1) expression = `${columnSql} ${negated ? "NOT " : ""}LIKE ${quoteLiteral(`%${uniqueValues[0]}%`)}`;
  else if (uniqueValues.length > 1 && /\b(?:either|or)\b/i.test(request)) expression = `${columnSql} ${negated ? "NOT " : ""}IN (${uniqueValues.map(quoteLiteral).join(", ")})`;
  else expression = `${columnSql} ${negated ? "!=" : "="} ${quoteLiteral(uniqueValues[0])}`;
  return { expressions: [expression], usedFields: new Set([field(selected.column)]) };
}

function explicitSubstringFilterSql(request: string, columns: DatasetColumn[]) {
  const literal = request.match(/\bletter\s+["'`]*\s*([A-Za-z0-9])(?:\s*["'`]*)/i)?.[1];
  if (!literal) return null;
  const requestTokens = new Set(words(request));
  const anchor = request.toLowerCase().indexOf("letter");
  const ranked = columns.filter(textColumn).map((column) => {
    const meaning = columnMeaningTokens(column);
    const overlap = meaning.filter((token) => requestTokens.has(token)).length;
    const positions = meaning.map((token) => request.toLowerCase().indexOf(token, Math.max(0, anchor))).filter((index) => index >= 0);
    const afterDistance = positions.length ? Math.min(...positions) - anchor : Number.MAX_SAFE_INTEGER;
    return { column, overlap, afterDistance };
  }).filter((item) => item.overlap > 0).sort((left, right) => left.afterDistance - right.afterDistance || right.overlap - left.overlap || left.column.name.localeCompare(right.column.name));
  if (!ranked[0] || (ranked[1] && ranked[0].afterDistance === ranked[1].afterDistance && ranked[0].overlap === ranked[1].overlap)) return null;
  return `${quoteIdentifier(ranked[0].column.name)} LIKE ${quoteLiteral(`%${literal}%`)}`;
}

function aggregateOperations(request: string) {
  const lower = request.toLowerCase();
  const definitions = [
    { sql: "AVG", match: /\b(?:average|avg|mean)\b/g },
    { sql: "MAX", match: /\b(?:maximum|max)\b/g },
    { sql: "MIN", match: /\b(?:minimum|min)\b/g },
    { sql: "SUM", match: /\b(?:sum|total)\b/g },
  ];
  const matches = definitions.flatMap(({ sql, match }) => [...lower.matchAll(match)].map((item) => ({ sql, index: item.index ?? Number.MAX_SAFE_INTEGER })))
    .filter((item) => !(item.sql === "SUM" && /\btotal\s+(?:count|number)\b/i.test(request)))
    .sort((left, right) => left.index - right.index);
  const unique = new Map<string, { sql: string; index: number }>();
  for (const item of matches) if (!unique.has(item.sql)) unique.set(item.sql, item);
  return [...unique.values()].sort((left, right) => left.index - right.index);
}

function requestedGroupColumn(request: string, columns: DatasetColumn[], excluded?: DatasetColumn) {
  const semanticRequest = requestBeforeOrdering(request);
  const marker = semanticRequest.search(/\b(?:each|per|grouped\s+by|group\s+by|by)\b/i);
  if (marker < 0) return null;
  const tokens = words(semanticRequest.slice(marker));
  const ranked = columns.filter((column) => column !== excluded).map((column) => {
    const meaning = columnMeaningTokens(column);
    const overlap = meaning.filter((token) => tokens.includes(token)).length;
    return { column, overlap, coverage: overlap / Math.max(1, meaning.length) };
  }).filter((item) => item.overlap > 0).sort((left, right) => right.coverage - left.coverage || right.overlap - left.overlap || left.column.name.localeCompare(right.column.name));
  return ranked[0]?.coverage === 1 ? ranked[0].column : null;
}

function projectionRequestText(request: string) {
  const orderMarker = request.search(/\b(?:ascending|descending|ordered|order|sort|sorted)\b/i);
  let end = orderMarker >= 0 ? orderMarker : request.length;
  const constraintMarker = request.slice(0, end).search(/\b(?:directed\s+by|written\s+by|named|whose|where|when|that\s+(?:are|contain|contains|have|has|is|were)|after|before|in\s+(?:the\s+)?(?:city|country|region|state)|from\s+(?:the\s+)?(?:city|country|region|state)|(?:by|of)\s+the\s+(?:highest|lowest|most|least|oldest|youngest)|with\s+(?:the\s+)?(?:description|code|value))\b/i);
  if (constraintMarker >= 0) end = Math.min(end, constraintMarker);
  return request.slice(0, end);
}

function declaredRelationship(columns: DatasetColumn[], leftTable: string, rightTable: string) {
  for (const column of columns.filter((item) => item.table === leftTable)) {
    const reference = column.references?.find((item) => item.table === rightTable);
    if (reference) return { leftColumn: column.name, rightColumn: reference.column };
  }
  for (const column of columns.filter((item) => item.table === rightTable)) {
    const reference = column.references?.find((item) => item.table === leftTable);
    if (reference) return { leftColumn: reference.column, rightColumn: column.name };
  }
  return null;
}

function requestedOutputColumns(request: string, columns: DatasetColumn[]) {
  const commandMatches = [...request.matchAll(/\b(?:give|list|return|show)\b/gi)];
  const requestedSegment = commandMatches.length ? request.slice((commandMatches.at(-1)?.index ?? 0) + commandMatches.at(-1)![0].length) : request;
  const segment = projectionRequestText(requestedSegment);
  const tokens = words(segment);
  const ranked = columns.map((column) => {
    const meaning = columnMeaningTokens(column);
    const overlap = meaning.filter((token) => tokens.includes(token)).length;
    const exact = phraseIndex(tokens, meaning);
    const mentioned = meaning.map((token) => tokens.indexOf(token)).filter((index) => index >= 0);
    return { column, meaning, overlap, coverage: overlap / Math.max(1, meaning.length), mentionIndex: exact >= 0 ? exact : mentioned.length ? Math.max(...mentioned) : Number.MAX_SAFE_INTEGER };
  }).filter((item) => item.overlap > 0 && item.coverage === 1)
    .sort((left, right) => left.mentionIndex - right.mentionIndex || left.column.name.localeCompare(right.column.name));
  return ranked.filter((item) => {
    if (item.meaning.length !== 1) return true;
    const occurrences = tokens.filter((token) => token === item.meaning[0]).length;
    if (occurrences <= 1 && ranked.some((other) => other !== item && other.meaning.length > 1 && other.meaning.includes(item.meaning[0]))) return false;
    const tableTokens = words(item.column.table ?? "");
    const tableLabel = tableTokens.length > 0 && tableTokens.length === item.meaning.length && tableTokens.every((token, index) => token === item.meaning[index]);
    const rawTable = (item.column.table ?? "").replaceAll("_", " ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (tableLabel && ranked.length > 1 && new RegExp(`\\bof\\s+(?:all\\s+|the\\s+)?${rawTable}s?\\b`, "i").test(segment)) return false;
    return true;
  }).slice(0, 6).map((item) => item.column);
}

function comparisonOperator(request: string) {
  if (/\b(?:at least|no fewer than)\b/i.test(request)) return ">=";
  if (/\b(?:at most|no more than)\b/i.test(request)) return "<=";
  if (/\b(?:fewer|less|under)\b/i.test(request)) return "<";
  if (/\b(?:greater|more|over)\b/i.test(request)) return ">";
  return null;
}

function explicitColumnComparison(request: string, columns: DatasetColumn[]) {
  const matches = [...request.matchAll(/\b(under|below|less than|fewer than|over|above|more than|greater than|at least|at most)\s+(?:the\s+)?([a-z][a-z0-9 _-]{0,36}?)\s+(-?\d+(?:\.\d+)?)\b/gi)];
  for (const match of matches) {
    const phraseTokens = words(match[2]);
    const ranked = columns.map((column) => {
      const meaning = columnMeaningTokens(column);
      const overlap = meaning.filter((token) => phraseTokens.includes(token)).length;
      return { column, coverage: overlap / Math.max(1, meaning.length), overlap };
    }).filter((item) => item.overlap > 0).sort((left, right) => right.coverage - left.coverage || right.overlap - left.overlap || left.column.name.localeCompare(right.column.name));
    if (!ranked[0] || ranked[0].coverage !== 1 || (ranked[1] && ranked[0].coverage === ranked[1].coverage && ranked[0].overlap === ranked[1].overlap)) continue;
    const operator = /^(?:under|below|less than|fewer than)$/i.test(match[1]) ? "<"
      : /^(?:at most)$/i.test(match[1]) ? "<="
        : /^(?:at least)$/i.test(match[1]) ? ">=" : ">";
    return { column: ranked[0].column, operator, value: match[3] };
  }
  return null;
}

function groupedCountCompilerCandidate(request: string, columns: DatasetColumn[]) {
  const threshold = request.match(/\b(more than|greater than|over|at least|no fewer than|fewer than|less than|under|at most|no more than)\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+([a-z][a-z0-9_-]*)/i);
  if (!threshold) return null;
  const countValue = numericTokenValue(threshold[2]);
  if (!countValue) return null;
  const nounTokens = words(threshold[3]);
  const table = [...new Set(columns.flatMap((column) => column.table ? [column.table] : []))].find((candidate) => words(candidate).some((token) => nounTokens.includes(token)));
  if (!table) return null;
  const tableColumns = columns.filter((column) => column.table === table);
  const outputs = requestedOutputColumns(request, tableColumns).filter((column) => !columnMeaningTokens(column).some((token) => nounTokens.includes(token) && /(?:^|_)(?:id|number)$/i.test(column.name)));
  const rowFilter = explicitColumnComparison(request.slice((threshold.index ?? 0) + threshold[0].length), tableColumns);
  if (!outputs.length || !rowFilter) return null;
  const operator = /^(?:more than|greater than|over)$/i.test(threshold[1]) ? ">"
    : /^(?:at least|no fewer than)$/i.test(threshold[1]) ? ">="
      : /^(?:at most|no more than)$/i.test(threshold[1]) ? "<=" : "<";
  const selected = outputs.map((column) => quoteIdentifier(column.name)).join(", ");
  return {
    query: `SELECT ${selected} FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(rowFilter.column.name)} ${rowFilter.operator} ${rowFilter.value} GROUP BY ${selected} HAVING COUNT(*) ${operator} ${countValue}`,
    explanation: "Apply the row-level comparison before grouping, then apply the requested group-count threshold.", source: "compiler" as const,
  };
}

function relationalCompilerCandidate(request: string, columns: DatasetColumn[], groundedValues: GroundedSchemaValue[]) {
  const tables = [...new Set(columns.flatMap((column) => column.table ? [column.table] : []))];
  const named = tableCandidates(columns, request);
  const operations = aggregateOperations(request);

  const relationshipCountThreshold = request.match(/\b(more than|greater than|over|at least|no fewer than|fewer than|less than|under|at most|no more than)\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+([a-z][a-z0-9_-]*)/i);
  const requestedCountValue = relationshipCountThreshold ? numericTokenValue(relationshipCountThreshold[2]) : null;
  if (!/\bor\b/i.test(request) && (isCountRequest(request) || requestedCountValue)) {
    const rankedTargets = tables.map((target) => {
      const outputs = requestedOutputColumns(request, columns.filter((column) => column.table === target));
      const tableRank = named.findIndex((item) => item.table === target);
      return { target, outputs, tableRank: tableRank < 0 ? Number.MAX_SAFE_INTEGER : tableRank };
    }).filter((item) => item.outputs.length > 0).sort((left, right) => right.outputs.length - left.outputs.length || left.tableRank - right.tableRank || left.target.localeCompare(right.target));
    for (const { target, outputs } of rankedTargets) for (const related of named.map((item) => item.table).filter((table) => table !== target)) {
      if (relationshipCountThreshold && !words(related).some((token) => words(relationshipCountThreshold[3]).includes(token))) continue;
      const relationship = declaredRelationship(columns, target, related);
      if (!relationship) continue;
      const selected = outputs.map((column) => `t.${quoteIdentifier(column.name)}`);
      const countIndex = request.search(/\b(?:count|how many|number)\b/i);
      const outputIndex = Math.min(...outputs.flatMap((column) => columnMeaningTokens(column).map((token) => request.toLowerCase().indexOf(token))).filter((index) => index >= 0));
      const projection = countIndex >= 0 && countIndex < outputIndex ? [`COUNT(*)`, ...selected] : [...selected, `COUNT(*)`];
      const havingOperator = relationshipCountThreshold
        ? /^(?:more than|greater than|over)$/i.test(relationshipCountThreshold[1]) ? ">"
          : /^(?:at least|no fewer than)$/i.test(relationshipCountThreshold[1]) ? ">="
            : /^(?:at most|no more than)$/i.test(relationshipCountThreshold[1]) ? "<=" : "<"
        : null;
      return {
        query: `SELECT ${projection.join(", ")} FROM ${quoteIdentifier(target)} AS t JOIN ${quoteIdentifier(related)} AS r ON t.${quoteIdentifier(relationship.leftColumn)} = r.${quoteIdentifier(relationship.rightColumn)} GROUP BY ${selected.join(", ")}${havingOperator && requestedCountValue ? ` HAVING COUNT(*) ${havingOperator} ${requestedCountValue}` : ""}`,
        explanation: "Count declared-key related rows at the requested entity grain.", source: "compiler" as const,
      };
    }
  }

  const groundedTables = [...new Set(groundedValues.map((match) => match.field.split(".")[0]).filter(Boolean))];
  const rankedProjectionTargets = tables.map((target) => ({
    target,
    outputs: requestedOutputColumns(request, columns.filter((column) => column.table === target)),
    tableRank: named.findIndex((item) => item.table === target),
  })).filter((item) => item.outputs.length > 0 && item.tableRank >= 0)
    .sort((left, right) => right.outputs.length - left.outputs.length || left.tableRank - right.tableRank || left.target.localeCompare(right.target));
  const maximumProjectionFields = Math.max(0, ...rankedProjectionTargets.map((item) => item.outputs.length));
  const locallyAnswerable = rankedProjectionTargets.some((candidate) => candidate.outputs.length === maximumProjectionFields
    && groundedFilterSql(request, candidate.target, columns.filter((column) => column.table === candidate.target), groundedValues).expressions.length > 0);
  for (const { target, outputs } of operations.length === 0 && !isCountRequest(request) && !/\bor\b/i.test(request) && !locallyAnswerable ? rankedProjectionTargets : []) {
    for (const related of groundedTables.filter((table) => table !== target)) {
      const relatedColumns = columns.filter((column) => column.table === related);
      const direct = groundedFilterSql(request, related, relatedColumns, groundedValues);
      const relationship = declaredRelationship(columns, target, related);
      if (!direct.expressions.length || !relationship) continue;
      return {
        query: `SELECT ${outputs.map((column) => `t.${quoteIdentifier(column.name)}`).join(", ")} FROM ${quoteIdentifier(target)} AS t JOIN ${quoteIdentifier(related)} AS r ON t.${quoteIdentifier(relationship.leftColumn)} = r.${quoteIdentifier(relationship.rightColumn)} WHERE ${direct.expressions.map((item) => item.replace(/^"([^"]+)"/, 'r."$1"')).join(" AND ")}`,
        explanation: "Project requested fields through one declared relationship and an explicit grounded filter.", source: "compiler" as const,
      };
    }
  }

  if (/\bor\b/i.test(request)) {
    const number = numericLiteral(request);
    const operator = comparisonOperator(request);
    for (const target of tables) {
      const targetColumns = columns.filter((column) => column.table === target);
      const outputs = requestedOutputColumns(request, targetColumns);
      const direct = groundedFilterSql(request, target, targetColumns, groundedValues);
      if (!outputs.length || !direct.expressions.length || !number || !operator) continue;
      for (const related of named.map((item) => item.table).filter((table) => table !== target)) {
        const relationship = declaredRelationship(columns, target, related);
        if (!relationship) continue;
        const selected = outputs.map((column) => `t.${quoteIdentifier(column.name)}`).join(", ");
        const grouping = outputs.map((column) => `t.${quoteIdentifier(column.name)}`).join(", ");
        return {
          query: `SELECT ${selected} FROM ${quoteIdentifier(target)} AS t WHERE ${direct.expressions.map((item) => item.replace(/^"([^"]+)"/, 't."$1"')).join(" AND ")} UNION SELECT ${selected} FROM ${quoteIdentifier(target)} AS t JOIN ${quoteIdentifier(related)} AS r ON t.${quoteIdentifier(relationship.leftColumn)} = r.${quoteIdentifier(relationship.rightColumn)} GROUP BY ${grouping} HAVING COUNT(*) ${operator} ${number}`,
          explanation: "Combine a direct entity filter with a declared-key related-event count alternative.", source: "compiler" as const,
        };
      }
    }
  }

  if (operations.length === 1 && named.length >= 2 && /\b(?:have|has|through|with|went)\b/i.test(request)) {
    for (const target of named.map((item) => item.table)) {
      const targetColumns = columns.filter((column) => column.table === target);
      const measures = targetColumns.filter((column) => columnMeaningTokens(column).some((token) => words(request).includes(token)) && !/(?:^|_)(?:id|code|key|number)$/i.test(column.name));
      if (measures.length !== 1) continue;
      for (const related of named.map((item) => item.table).filter((table) => table !== target)) {
        const relationship = declaredRelationship(columns, target, related);
        if (!relationship) continue;
        const measure = /CHAR|TEXT|STRING|VARCHAR|ENUM/i.test(measures[0].type) ? `TRY_CAST(t.${quoteIdentifier(measures[0].name)} AS DOUBLE)` : `t.${quoteIdentifier(measures[0].name)}`;
        return {
          query: `SELECT ${operations[0].sql}(${measure}) FROM ${quoteIdentifier(target)} AS t WHERE EXISTS (SELECT 1 FROM ${quoteIdentifier(related)} AS r WHERE r.${quoteIdentifier(relationship.rightColumn)} = t.${quoteIdentifier(relationship.leftColumn)})`,
          explanation: "Aggregate the requested entity measure after a declared-key related-row existence filter.", source: "compiler" as const,
        };
      }
    }
  }
  return null;
}

function compilerCandidates(request: string, columns: DatasetColumn[], groundedValues: GroundedSchemaValue[]) {
  const candidates: Array<{ query: string; explanation: string; source: "compiler" }> = [];
  const lower = request.toLowerCase();
  const tables = tableCandidates(columns, request);

  const groupedCount = groupedCountCompilerCandidate(request, columns);
  if (groupedCount) return [groupedCount];

  if (/\bboth\b/.test(lower) && tables.length >= 2) {
    for (let leftIndex = 0; leftIndex < tables.length; leftIndex += 1) for (let rightIndex = leftIndex + 1; rightIndex < tables.length; rightIndex += 1) {
      const leftColumns = columns.filter((column) => column.table === tables[leftIndex].table);
      const rightByName = new Map(columns.filter((column) => column.table === tables[rightIndex].table).map((column) => [words(column.name).join(" "), column]));
      const shared = leftColumns.filter((column) => words(column.name).some((token) => words(request).includes(token)) && rightByName.has(words(column.name).join(" ")));
      if (shared.length !== 1) continue;
      const right = rightByName.get(words(shared[0].name).join(" "))!;
      candidates.push({
        query: `SELECT ${quoteIdentifier(shared[0].name)} FROM ${quoteIdentifier(tables[leftIndex].table)} INTERSECT SELECT ${quoteIdentifier(right.name)} FROM ${quoteIdentifier(tables[rightIndex].table)}`,
        explanation: "Return values present in both directly named entity tables.", source: "compiler",
      });
      return candidates;
    }
  }

  const relational = relationalCompilerCandidate(request, columns, groundedValues);
  if (relational) {
    candidates.push(relational);
    return candidates;
  }

  const groundedTables = [...new Set(groundedValues.map((match) => match.field.split(".")[0]).filter(Boolean))];
  const table = uniquelyRelevantTable(columns, request) ?? uniquelyRelevantTableByColumns(columns, request) ?? (groundedTables.length === 1 ? groundedTables[0] : null);
  if (!table) return candidates;
  const tableColumns = columns.filter((column) => column.table === table);
  const numeric = numericFilter(request, tableColumns);
  const groundedFilters = groundedFilterSql(request, table, tableColumns, numeric
    ? groundedValues.filter((match) => match.field !== field(numeric.column))
    : groundedValues);
  const explicitSubstring = groundedFilters.expressions.length ? null : explicitSubstringFilterSql(request, tableColumns);
  const filters = [
    ...(numeric ? [`${quoteIdentifier(numeric.column.name)} ${numeric.operator} ${numeric.value}`] : []),
    ...groundedFilters.expressions,
    ...(explicitSubstring ? [explicitSubstring] : []),
  ];
  const hasUncompiledConstraint = (/["']/.test(request) && !groundedFilters.expressions.length && !explicitSubstring)
    || (/\b(?:above|after|at least|at most|before|below|fewer|greater|higher|less|lighter|lower|more|older|over|under|younger)\b/i.test(request) && Boolean(numericLiteral(request)) && !numeric);
  const countRequest = isCountRequest(request);
  const aggregateRequests = aggregateOperations(request);
  const measureCandidates = tableColumns.filter((column) => /INT|DECIMAL|DOUBLE|FLOAT|HUGEINT|NUMERIC|REAL/i.test(column.type)).map((column) => {
    const meaning = columnMeaningTokens(column);
    const overlap = meaning.filter((token) => words(request).includes(token)).length;
    return { column, overlap, coverage: overlap / Math.max(1, meaning.length) };
  }).filter((item) => item.overlap > 0).sort((left, right) => right.coverage - left.coverage || right.overlap - left.overlap || left.column.name.localeCompare(right.column.name));
  const measure = measureCandidates[0] && (!measureCandidates[1] || measureCandidates[0].coverage > measureCandidates[1].coverage || measureCandidates[0].overlap > measureCandidates[1].overlap) ? measureCandidates[0].column : null;
  const groupColumn = requestedGroupColumn(request, tableColumns, measure ?? undefined);
  const aggregateGroupingRequested = /\b(?:each|per|grouped\s+by|group\s+by|by)\b/i.test(requestBeforeOrdering(request));
  const coordinatedMeasures = tableColumns.filter((column) => /INT|DECIMAL|DOUBLE|FLOAT|HUGEINT|NUMERIC|REAL/i.test(column.type) && !/(?:^|_)(?:id|code|key|number)$/i.test(column.name)).map((column) => {
    const meaning = columnMeaningTokens(column); const requestTokens = words(request);
    const overlap = meaning.filter((token) => requestTokens.includes(token)).length;
    const indexes = meaning.map((token) => requestTokens.indexOf(token)).filter((index) => index >= 0);
    return { column, coverage: overlap / Math.max(1, meaning.length), mentionIndex: indexes.length ? Math.min(...indexes) : Number.MAX_SAFE_INTEGER };
  }).filter((item) => item.coverage === 1).sort((left, right) => left.mentionIndex - right.mentionIndex || left.column.name.localeCompare(right.column.name));
  if (aggregateRequests.length === 1 && coordinatedMeasures.length >= 2 && /\band\b/i.test(request) && tables.length < 2 && !aggregateGroupingRequested && !hasUncompiledConstraint) {
    candidates.push({
      query: `SELECT ${coordinatedMeasures.slice(0, 4).map((item) => `${aggregateRequests[0].sql}(${quoteIdentifier(item.column.name)})`).join(", ")} FROM ${quoteIdentifier(table)}${filters.length ? ` WHERE ${filters.join(" AND ")}` : ""}`,
      explanation: "Compute the requested aggregate independently for each coordinated measure.", source: "compiler",
    });
    return candidates;
  }
  if (countRequest
    && !/\b(?:average|distinct|different|ratio|rate|unique)\b/i.test(request)
    && !(groupColumn && tables.length >= 2)
    && (!aggregateGroupingRequested || groupColumn)
    && !hasUncompiledConstraint) {
    const countIndex = request.search(/\b(?:count|how many|number)\b/i);
    const groupIndex = groupColumn ? Math.min(...columnMeaningTokens(groupColumn).map((token) => request.toLowerCase().indexOf(token)).filter((index) => index >= 0)) : Number.MAX_SAFE_INTEGER;
    const selected = groupColumn
      ? countIndex >= 0 && countIndex < groupIndex ? `COUNT(*), ${quoteIdentifier(groupColumn.name)}` : `${quoteIdentifier(groupColumn.name)}, COUNT(*)`
      : "COUNT(*)";
    const grouped = groupColumn ? ` GROUP BY ${quoteIdentifier(groupColumn.name)}` : "";
    candidates.push({ query: `SELECT ${selected} FROM ${quoteIdentifier(table)}${filters.length ? ` WHERE ${filters.join(" AND ")}` : ""}${grouped}`, explanation: "Count the directly named entity population with explicit grounded filters and grouping.", source: "compiler" });
    return candidates;
  }

  if (aggregateRequests.length && measure && tables.length < 2 && (!aggregateGroupingRequested || groupColumn) && !hasUncompiledConstraint) {
    const aggregates = aggregateRequests.map((operation) => `${operation.sql}(${quoteIdentifier(measure.name)})`);
    const aggregateIndex = Math.min(...aggregateRequests.map((operation) => operation.index));
    const groupTokens = groupColumn ? columnMeaningTokens(groupColumn) : [];
    const groupIndex = groupColumn ? Math.min(...groupTokens.map((token) => request.toLowerCase().indexOf(token)).filter((index) => index >= 0)) : Number.MAX_SAFE_INTEGER;
    const selected = groupColumn && groupIndex < aggregateIndex
      ? [quoteIdentifier(groupColumn.name), ...aggregates]
      : groupColumn ? [...aggregates, quoteIdentifier(groupColumn.name)] : aggregates;
    candidates.push({
      query: `SELECT ${selected.join(", ")} FROM ${quoteIdentifier(table)}${filters.length ? ` WHERE ${filters.join(" AND ")}` : ""}${groupColumn ? ` GROUP BY ${quoteIdentifier(groupColumn.name)}` : ""}`,
      explanation: "Compute the explicitly requested aggregates at the requested single-table grain.", source: "compiler",
    });
    return candidates;
  }

  const localGroundedValues = new Set(groundedValues.filter((match) => match.field.startsWith(`${table}.`)).map((match) => match.value.toLocaleLowerCase("en-US")));
  const hasExternalGrounding = groundedValues.some((match) => !match.field.startsWith(`${table}.`) && !localGroundedValues.has(match.value.toLocaleLowerCase("en-US")));
  const requiresAggregatePlanning = /\b(?:average|avg|maximum|max|mean|minimum|min|sum|total|group(?:ed)?|each|per)\b/i.test(request);
  if (!countRequest && !hasExternalGrounding && !/\bthat\s+(?:code|id|identifier|one)\b/i.test(request)
    && !requiresAggregatePlanning
    && !hasUncompiledConstraint
    && /\b(?:find|give|how much|list|return|show|what|which)\b/i.test(request) && !/\bboth\b/i.test(request)) {
    const orderMarker = request.search(/\b(?:ascending|descending|ordered|order|sort|sorted)\b/i);
    const requestedOutputs = requestedOutputColumns(request, tableColumns);
    const fallback = tableColumns.map((column) => {
      const tokens = columnMeaningTokens(column); const projectionTokens = words(projectionRequestText(request));
      return { column, overlap: tokens.filter((token) => projectionTokens.includes(token)).length };
    }).filter((item) => item.overlap > 0).sort((left, right) => right.overlap - left.overlap || left.column.name.localeCompare(right.column.name))[0]?.column;
    const outputs = (requestedOutputs.length ? requestedOutputs : fallback ? [fallback] : []).filter((column) => !groundedFilters.usedFields.has(field(column)));
    if (outputs.length) {
      const selected = outputs.map((column) => quoteIdentifier(column.name)).join(", ");
      const order = requestedOrder(request, tableColumns, outputs[0]);
      if (orderMarker >= 0 && !order) return candidates;
      const orderSql = order ? ` ORDER BY ${quoteIdentifier(order.column.name)} ${order.direction}${order.limit ? " LIMIT 1" : ""}` : "";
      const distinct = /\b(?:distinct|different|unique)\b/i.test(request) ? "DISTINCT " : "";
      candidates.push({ query: `SELECT ${distinct}${selected} FROM ${quoteIdentifier(table)}${filters.length ? ` WHERE ${filters.join(" AND ")}` : ""}${orderSql}`, explanation: "Project the requested fields from the minimum relevant table with explicit grounded filters and ordering.", source: "compiler" });
    }
  }
  return candidates;
}

async function executeCandidate(request: string, candidate: { query: string; explanation: string; source: OpenWorldSqlAttempt["source"] }, index: number, executeSql: (query: string) => Promise<SqlExecutionResult>): Promise<OpenWorldSqlAttempt> {
  let query: string;
  try { query = validateSqlPreviewQuery(candidate.query); }
  catch (error) { return { ...candidate, query: candidate.query, status: "invalid", score: -1_000, error: error instanceof Error ? error.message : "Invalid read-only query." }; }
  let violation = semanticViolation(request, query);
  if (violation?.startsWith("The query invented a result limit") && !/\border\s+by\b/i.test(query)) {
    const withoutLimit = query.replace(/\s+LIMIT\s+\d+\s*;?\s*$/i, "");
    if (withoutLimit !== query) {
      try {
        query = validateSqlPreviewQuery(withoutLimit);
        violation = semanticViolation(request, query);
      } catch { /* Retain the original violation. */ }
    }
  }
  if (violation) return { ...candidate, query, status: "invalid", score: -1_000, error: violation };
  try {
    const execution = await executeSql(query);
    return { ...candidate, query, status: "success", score: semanticScore(request, query, candidate.source, index), execution };
  } catch (error) {
    return { ...candidate, query, status: "execution-error", score: -500, error: (error instanceof Error ? error.message : "Execution failed.").slice(0, 600) };
  }
}

function selectAttempt(request: string, attempts: OpenWorldSqlAttempt[]) {
  const successful = attempts.filter((attempt): attempt is OpenWorldSqlAttempt & { execution: SqlExecutionResult } => attempt.status === "success" && Boolean(attempt.execution));
  const compiled = successful.find((attempt) => attempt.source === "compiler");
  const consensus = new Map<string, number>();
  for (const attempt of successful) {
    const key = resultFingerprint(attempt.execution);
    consensus.set(key, (consensus.get(key) ?? 0) + 1);
  }
  for (const attempt of successful) attempt.score += (consensus.get(resultFingerprint(attempt.execution)) ?? 1) * 6;
  const requestSignalsConstraint = /\b(?:after|before|directed|either|from|in|named|not|whose|where|when|with)\b/i.test(request) || /\ball\s+[A-Z][a-z]+\s+/.test(request);
  if (compiled) {
    const filteredAlternative = !/\b(?:where|having|union)\b/i.test(compiled.query) && requestSignalsConstraint
      ? successful.filter((attempt) => attempt !== compiled && /\b(?:where|having|union)\b/i.test(attempt.query)).sort((left, right) => right.score - left.score || left.query.localeCompare(right.query))[0]
      : null;
    return filteredAlternative ?? compiled;
  }
  return successful.sort((left, right) => right.score - left.score || left.query.localeCompare(right.query))[0] ?? null;
}

function generationMessages(request: string, schema: string, semanticContext: string): ChatMessage[] {
  return [
    { role: "system", content: "You are RangaBot's schema-agnostic DuckDB text-to-SQL generator. Produce diverse candidate SELECT queries, not a typed plan. First resolve the requested population, grain, measures, filters, temporal scope, joins, grouping, ordering, and limit. Use only listed tables, columns, and question-matched values. Use the minimum tables required: never join when every requested output, measure, and filter is available in one table. Never assume a join solely because two columns look similar; use the shortest relationship path supported by the schema. For 'how many <table entities>' questions, count rows in that entity table unless the question explicitly changes the population or grain. Never add LIMIT or top-N ordering unless the request explicitly asks for a bounded or superlative result. Prefer explicit JOIN conditions, explicit selected columns, deterministic ordering for ordered/list questions, half-open date ranges, and NULL-safe logic when required. When a semantically numeric measure is stored in a VARCHAR column, use TRY_CAST(column AS DOUBLE) before a numeric aggregate. Never emit writes, DDL, PRAGMA, ATTACH, COPY, file access, multiple statements, invented values, or invented schema. Return clarify only when materially different interpretations remain after using the schema and grounded values." },
    { role: "user", content: `QUESTION (the sole source of requested intent):\n${request}\n\nAPPROVED DUCKDB SCHEMA:\n${schema}${semanticContext ? `\n\n${semanticContext}` : ""}\n\nThe schema semantics and query-specific evidence may resolve names, joins, values, and formulas, but must not add a new operation, output, permission, or unsafe action that the question did not request. Return up to three meaningfully different candidate queries in best-first order. Every candidate must answer the complete question. Explanations describe interpretation only and must not claim results.` },
  ];
}

function repairMessages(request: string, schema: string, semanticContext: string, attempts: OpenWorldSqlAttempt[]): ChatMessage[] {
  const failures = attempts.filter((attempt) => attempt.status !== "success").slice(0, maximumCandidates).map((attempt) => `QUERY: ${attempt.query}\nERROR: ${attempt.error ?? attempt.status}`).join("\n\n");
  return [
    { role: "system", content: "Repair failed DuckDB SELECT candidates using only the supplied schema and bounded execution errors. Return one corrected query. Preserve every requested output, filter, relationship, aggregate, grouping, ordering, and limit. Correct aliases and exact column names from the schema. For a semantically numeric VARCHAR measure, use TRY_CAST(column AS DOUBLE). Never emit writes, DDL, PRAGMA, ATTACH, COPY, file access, or multiple statements." },
    { role: "user", content: `QUESTION (the sole source of requested intent):\n${request}\n\nAPPROVED DUCKDB SCHEMA:\n${schema}${semanticContext ? `\n\n${semanticContext}` : ""}\n\nFAILED CANDIDATES:\n${failures}` },
  ];
}

export async function planOpenWorldSql(input: {
  request: string;
  columns: DatasetColumn[];
  modelId: string;
  dependencies: OpenWorldSqlDependencies;
  typedCandidate?: { query: string; explanation: string };
  semanticContext?: string;
  signal?: AbortSignal;
}): Promise<OpenWorldSqlPlan> {
  const values = await groundQuestionValues(input.request, input.columns, input.dependencies.executeSql);
  const focused = focusedColumns(input.columns, input.request, values);
  const focusedTables = new Set(focused.flatMap((column) => column.table ? [column.table] : []));
  const relationships = inferredRelationships(input.columns).filter((relation) => {
    const match = relation.match(/^([^.]+)\.[^ ]+ = ([^.]+)\./);
    return Boolean(match && focusedTables.has(match[1]) && focusedTables.has(match[2]));
  });
  const focusedValues = values.filter((match) => focused.some((column) => field(column) === match.field));
  const schema = schemaText(focused, relationships, focusedValues);
  const raw = await input.dependencies.completeJson(generationMessages(input.request, schema, input.semanticContext ?? ""), {
    jsonSchema: openWorldSqlCandidateSchema as unknown as Record<string, unknown>, numPredict: 2_400, modelId: input.modelId, temperature: 0, seed: 17, signal: input.signal,
  });
  const document = parseDocument(raw);
  const compiled = compilerCandidates(input.request, focused, focusedValues);
  if (document.decision !== "query" && !compiled.length && !input.typedCandidate?.query.trim()) return {
    version: OPEN_WORLD_SQL_PLANNER_VERSION, action: document.decision, explanation: document.explanation,
    focusedFields: focused.map(field), groundedValues: focusedValues, attempts: [],
  };
  const rawCandidates = [
    ...compiled,
    ...(input.typedCandidate?.query.trim() ? [{ ...input.typedCandidate, source: "typed" as const }] : []),
    ...(document.decision === "query" ? document.candidates.map((candidate) => ({ ...candidate, source: "model" as const })) : []),
  ];
  const unique = [...new Map(rawCandidates.map((candidate) => [candidate.query.trim().replace(/;\s*$/, ""), candidate])).values()].slice(0, maximumCandidates + 2);
  const attempts: OpenWorldSqlAttempt[] = [];
  for (let index = 0; index < unique.length; index += 1) attempts.push(await executeCandidate(input.request, unique[index], index, input.dependencies.executeSql));
  let selected = selectAttempt(input.request, attempts);
  if (!selected && attempts.some((attempt) => attempt.status !== "success")) {
    const repairRaw = await input.dependencies.completeJson(repairMessages(input.request, schema, input.semanticContext ?? "", attempts), {
      jsonSchema: openWorldSqlCandidateSchema as unknown as Record<string, unknown>, numPredict: 1_200, modelId: input.modelId, temperature: 0, seed: 18, signal: input.signal,
    });
    const repair = parseDocument(repairRaw);
    if (repair.decision === "query" && repair.candidates[0]) attempts.push(await executeCandidate(input.request, { ...repair.candidates[0], source: "repair" }, attempts.length, input.dependencies.executeSql));
    selected = selectAttempt(input.request, attempts);
  }
  if (!selected) return {
    version: OPEN_WORLD_SQL_PLANNER_VERSION, action: "clarify", explanation: "I could not produce a verified read-only query for this schema. Please name the intended population, measure, or relationship more explicitly.",
    focusedFields: focused.map(field), groundedValues: focusedValues, attempts,
  };
  return {
    version: OPEN_WORLD_SQL_PLANNER_VERSION, action: "query", explanation: selected.explanation,
    focusedFields: focused.map(field), groundedValues: focusedValues, attempts, selected,
  };
}
