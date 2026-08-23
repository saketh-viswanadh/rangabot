import type { DatasetColumn } from "./sql-runtime.ts";
import type { SqlProposal } from "./sql-proposals.ts";
import { validateSqlPreviewQuery } from "./sql-confirmations.ts";

export type ExpertRelationalPlan = {
  operation: "year_over_year" | "cohort_first_period" | "funnel_counts" | "period_pivot" | "set_union" | "correlated_exists";
  source: string;
  entityRelation: string;
  entity: string;
  metric: string;
  dateField: string;
  groupField: string;
  filterField: string;
  filterValue: string;
  threshold: number;
  firstStart: string;
  firstEnd: string;
  secondStart: string;
  secondEnd: string;
  explanation: string;
};

const safeName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const numeric = (column: DatasetColumn) => /INT|DECIMAL|DOUBLE|REAL|FLOAT|NUMERIC/i.test(column.type) && !column.name.endsWith("_id");
const temporal = (column: DatasetColumn) => /DATE|TIME/i.test(column.type);
const identifier = (column: DatasetColumn) => column.name.endsWith("_id");
const textual = (column: DatasetColumn) => /CHAR|TEXT|STRING|ENUM/i.test(column.type);

function tokens(value: string) {
  return (value.toLowerCase().replaceAll("_", " ").match(/[a-z0-9]+/g) ?? []).map((token) => {
    if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
    if (token.length > 4 && /(?:ches|shes|xes|zes|sses)$/.test(token)) return token.slice(0, -2);
    return token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token;
  });
}

function containsSequence(haystack: string[], needle: string[]) {
  return needle.length > 0 && haystack.some((_, index) => needle.every((token, offset) => haystack[index + offset] === token));
}

function mentioned(request: string, value: string) {
  return containsSequence(tokens(request), tokens(value));
}

function tables(columns: DatasetColumn[]) {
  return [...new Set(columns.flatMap((column) => column.table ? [column.table] : []))];
}

function unique<T>(items: T[]) { return items.length === 1 ? items[0] : null; }
function field(table: string, name: string) { return `${table}.${name}`; }
function quote(value: string) { return `"${value.replaceAll('"', '""')}"`; }
function literal(value: string) { return `'${value.replaceAll("'", "''")}'`; }

function sharedKey(left: string, right: string, columns: DatasetColumn[]) {
  return unique(columns.filter((column) => column.table === left && identifier(column) && columns.some((candidate) => candidate.table === right && candidate.name === column.name)));
}

function namedColumns(request: string, columns: DatasetColumn[], predicate: (column: DatasetColumn) => boolean, table?: string) {
  return columns.filter((column) => column.table && (!table || column.table === table) && predicate(column) && mentioned(request, column.name));
}

function namedRelations(request: string, columns: DatasetColumn[]) {
  return tables(columns).filter((table) => mentioned(request, table));
}

function eventRelation(request: string, columns: DatasetColumn[]) {
  const named = namedRelations(request, columns).filter((table) => columns.some((column) => column.table === table && (temporal(column) || numeric(column))));
  if (named.length === 1) return named[0];
  const metrics = namedColumns(request, columns, numeric);
  if (metrics.length === 1) return metrics[0].table!;
  const requestedIds = namedColumns(request, columns, identifier);
  const linkedMetrics = metrics.filter((metric) => requestedIds.some((id) => id.name !== metric.name && columns.some((candidate) => candidate.table === metric.table && candidate.name === id.name)));
  return unique([...new Set(linkedMetrics.map((metric) => metric.table!))]);
}

function entityPair(source: string, request: string, columns: DatasetColumn[]) {
  const candidates = namedRelations(request, columns).filter((table) => table !== source).flatMap((table) => {
    const key = sharedKey(source, table, columns);
    return key ? [{ table, key }] : [];
  });
  return unique(candidates);
}

function empty(operation: ExpertRelationalPlan["operation"], source: string): ExpertRelationalPlan {
  return { operation, source, entityRelation: "", entity: "", metric: "", dateField: "", groupField: "", filterField: "", filterValue: "", threshold: 0, firstStart: "", firstEnd: "", secondStart: "", secondEnd: "", explanation: "Compile the explicitly evidenced expert relational operation." };
}

function monthRange(name: string, year: number) {
  const months: Record<string, number> = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
  const month = months[name.toLowerCase()]; if (!month) return null;
  const start = `${year}-${String(month).padStart(2, "0")}-01`; const nextMonth = month === 12 ? 1 : month + 1; const nextYear = month === 12 ? year + 1 : year;
  return { start, end: `${nextYear}-${String(nextMonth).padStart(2, "0")}-01` };
}

export function shouldUseExpertRelationalPlan(request: string) {
  return /\b(?:year[- ]over[- ]year|cohort|retention|funnel|pivot|cross[- ]tab|union|correlated\s+exists)\b/i.test(request);
}

export function resolveExpertRelationalPlan(request: string, columns: DatasetColumn[]): ExpertRelationalPlan | null {
  if (!shouldUseExpertRelationalPlan(request)) return null;
  const source = eventRelation(request, columns);
  if (!source) return null;
  const metric = unique(namedColumns(request, columns, numeric, source));
  const namedDates = namedColumns(request, columns, temporal, source);
  const sourceDates = columns.filter((column) => column.table === source && temporal(column));
  const exactDates = sourceDates.filter((column) => /^DATE$/i.test(column.type));
  const date = unique(namedDates) ?? unique(exactDates);
  const pair = entityPair(source, request, columns);

  if (/\byear[- ]over[- ]year\b/i.test(request) && metric && date) return { ...empty("year_over_year", source), metric: field(source, metric.name), dateField: field(source, date.name) };

  if (/\b(?:cohort|retention)\b/i.test(request) && date && pair) return { ...empty("cohort_first_period", source), entityRelation: pair.table, entity: field(source, pair.key.name), dateField: field(source, date.name) };

  if (/\bfunnel\b/i.test(request)) {
    const status = unique(columns.filter((column) => column.table === source && textual(column)));
    const relationWords = tokens(source); const requestWords = tokens(request); const toIndex = requestWords.indexOf("to");
    const relationIndex = requestWords.findIndex((_, index) => index > toIndex && relationWords.every((word, offset) => requestWords[index + offset] === word));
    const value = toIndex >= 0 && relationIndex > toIndex + 1 ? requestWords.slice(toIndex + 1, relationIndex).at(-1) ?? "" : "";
    if (status && value) return { ...empty("funnel_counts", source), filterField: field(source, status.name), filterValue: value };
  }

  if (/\b(?:pivot|cross[- ]tab)\b/i.test(request) && metric && date) {
    const entity = unique(namedColumns(request, columns, identifier, source));
    const ranges = [...request.matchAll(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/gi)].map((match) => monthRange(match[1], Number(match[2]))).filter((range): range is NonNullable<typeof range> => Boolean(range));
    if (entity && ranges.length === 2) return { ...empty("period_pivot", source), entity: field(source, entity.name), metric: field(source, metric.name), dateField: field(source, date.name), firstStart: ranges[0].start, firstEnd: ranges[0].end, secondStart: ranges[1].start, secondEnd: ranges[1].end };
  }

  if (/\bunion\b/i.test(request) && pair) {
    const group = unique(namedColumns(request, columns, textual, pair.table));
    const words = tokens(request); const groupIndex = group ? words.findIndex((word) => tokens(group.name).includes(word)) : -1; const value = groupIndex > 0 ? words[groupIndex - 1] : "";
    if (group && value) return { ...empty("set_union", source), entityRelation: pair.table, entity: field(source, pair.key.name), groupField: field(pair.table, group.name), filterValue: value };
  }

  if (/\bcorrelated\s+exists\b/i.test(request) && pair && metric) {
    const threshold = Number(request.match(/\b(?:above|greater than|more than|over)\s+(-?\d+(?:\.\d+)?)\b/i)?.[1] ?? Number.NaN);
    if (Number.isFinite(threshold)) return { ...empty("correlated_exists", source), entityRelation: pair.table, entity: field(pair.table, pair.key.name), metric: field(source, metric.name), threshold };
  }
  return null;
}

function ref(value: string, columns: DatasetColumn[]) {
  const [table, name, extra] = value.split("."); if (extra || !safeName.test(table) || !safeName.test(name) || !columns.some((column) => column.table === table && column.name === name)) throw new Error(`Unavailable expert relational field: ${value}`);
  return { table, name, sql: `${quote(table)}.${quote(name)}` };
}

export function compileExpertRelationalPlan(plan: ExpertRelationalPlan, columns: DatasetColumn[]): SqlProposal {
  if (!safeName.test(plan.source) || !columns.some((column) => column.table === plan.source)) throw new Error("Unavailable expert relational source.");
  let query: string;
  if (plan.operation === "year_over_year") {
    const metric = ref(plan.metric, columns); const date = ref(plan.dateField, columns); if (metric.table !== plan.source || date.table !== plan.source) throw new Error("Year-over-year fields must belong to one source relation.");
    query = `WITH ${quote("monthly")} AS (SELECT DATE_TRUNC('month', ${date.sql}) AS ${quote("period_month")}, SUM(${metric.sql}) AS ${quote("period_value")} FROM ${quote(plan.source)} GROUP BY 1) SELECT ${quote("period_month")}, ${quote("period_value")}, ${quote("period_value")} - LAG(${quote("period_value")}, 12) OVER (ORDER BY ${quote("period_month")}) AS ${quote("yoy_change")} FROM ${quote("monthly")} ORDER BY ${quote("period_month")}`;
  } else if (plan.operation === "cohort_first_period") {
    const entity = ref(plan.entity, columns); const date = ref(plan.dateField, columns); if (entity.table !== plan.source || date.table !== plan.source) throw new Error("Cohort fields must belong to one observation relation.");
    query = `WITH ${quote("first_period")} AS (SELECT ${entity.sql}, MIN(DATE_TRUNC('month', ${date.sql})) AS ${quote("cohort")} FROM ${quote(plan.source)} GROUP BY ${entity.sql}) SELECT ${quote("cohort")}, COUNT(*) AS ${quote("retained")} FROM ${quote("first_period")} GROUP BY ${quote("cohort")} ORDER BY ${quote("cohort")}`;
  } else if (plan.operation === "funnel_counts") {
    const filter = ref(plan.filterField, columns); if (filter.table !== plan.source || !plan.filterValue) throw new Error("Funnel scope is incomplete.");
    query = `SELECT COUNT(*) AS ${quote("all_events")}, COUNT(*) FILTER (WHERE ${filter.sql} = ${literal(plan.filterValue)}) AS ${quote("completed_events")} FROM ${quote(plan.source)}`;
  } else if (plan.operation === "period_pivot") {
    const entity = ref(plan.entity, columns); const metric = ref(plan.metric, columns); const date = ref(plan.dateField, columns); if ([entity, metric, date].some((item) => item.table !== plan.source)) throw new Error("Pivot fields must belong to one source relation.");
    query = `SELECT ${entity.sql}, SUM(${metric.sql}) FILTER (WHERE ${date.sql} >= DATE '${plan.firstStart}' AND ${date.sql} < DATE '${plan.firstEnd}') AS ${quote("first_period")}, SUM(${metric.sql}) FILTER (WHERE ${date.sql} >= DATE '${plan.secondStart}' AND ${date.sql} < DATE '${plan.secondEnd}') AS ${quote("second_period")} FROM ${quote(plan.source)} GROUP BY ${entity.sql} ORDER BY ${entity.sql}`;
  } else if (plan.operation === "set_union") {
    const eventEntity = ref(plan.entity, columns); const group = ref(plan.groupField, columns); const key = sharedKey(plan.source, plan.entityRelation, columns); if (!key || eventEntity.name !== key.name || group.table !== plan.entityRelation || !plan.filterValue) throw new Error("Set union relations are not directly and uniquely linked.");
    query = `SELECT ${quote(key.name)} FROM ${quote(plan.source)} UNION SELECT ${quote(key.name)} FROM ${quote(plan.entityRelation)} WHERE ${group.sql} = ${literal(plan.filterValue)} ORDER BY 1`;
  } else {
    const entity = ref(plan.entity, columns); const metric = ref(plan.metric, columns); const key = sharedKey(plan.source, plan.entityRelation, columns); if (!key || entity.table !== plan.entityRelation || entity.name !== key.name || metric.table !== plan.source || !Number.isFinite(plan.threshold)) throw new Error("Correlated existence relations are not directly and uniquely linked.");
    query = `SELECT ${quote("entity")}.${quote(key.name)} FROM ${quote(plan.entityRelation)} AS ${quote("entity")} WHERE EXISTS (SELECT 1 FROM ${quote(plan.source)} AS ${quote("observation")} WHERE ${quote("observation")}.${quote(key.name)} = ${quote("entity")}.${quote(key.name)} AND ${quote("observation")}.${quote(metric.name)} > ${plan.threshold}) ORDER BY ${quote("entity")}.${quote(key.name)}`;
  }
  return { action: "query", query: validateSqlPreviewQuery(query), explanation: "Run the deterministic schema-bound expert relational operation." };
}

export function expertRelationalOutputColumns(plan: ExpertRelationalPlan) {
  if (plan.operation === "year_over_year") return ["period_month", "period_value", "yoy_change"];
  if (plan.operation === "cohort_first_period") return ["cohort", "retained"];
  if (plan.operation === "funnel_counts") return ["all_events", "completed_events"];
  if (plan.operation === "period_pivot") return [plan.entity.split(".").at(-1)!, "first_period", "second_period"];
  return [plan.entity.split(".").at(-1)!];
}
