import type { ChatMessage } from "./providers/types.ts";
import type { DatasetDescriptor } from "./datasets.ts";
import type { DatasetColumn } from "./sql-runtime.ts";
import type { SqlProposal } from "./sql-proposals.ts";
import { focusDatabaseSchema } from "./sql-proposals.ts";
import { validateSqlPreviewQuery } from "./sql-confirmations.ts";

type Operator = "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "is_null" | "is_not_null";
type Aggregate = "count" | "sum" | "avg" | "min" | "max" | "median" | "quantile_90";
type WindowFunction = "row_number" | "rank" | "dense_rank" | "running_sum" | "moving_avg" | "lag" | "share_of_total";
type Direction = "asc" | "desc";
type MetricSlot = "metric_1" | "metric_2" | "metric_3";
type WindowSlot = "window_1" | "window_2";
type OutputReference = string | MetricSlot | WindowSlot;

export type GeneralSqlPlan = {
  action: "query" | "clarify" | "unavailable";
  source: string;
  dimensions: string[];
  filters: Array<{ column: string; operator: Operator; value: string }>;
  aggregates: Array<{ slot: MetricSlot; aggregate: Aggregate; field: string; distinct: boolean }>;
  windows: Array<{
    slot: WindowSlot;
    function: WindowFunction;
    input: string;
    partitionBy: string[];
    orderBy: Array<{ field: OutputReference; direction: Direction }>;
    frameRows: number;
  }>;
  having: Array<{ metric: MetricSlot; operator: Exclude<Operator, "is_null" | "is_not_null">; value: number }>;
  qualify: Array<{ window: WindowSlot; operator: "eq" | "lte"; value: number }>;
  orderBy: Array<{ field: OutputReference; direction: Direction }>;
  limit: number;
  explanation: string;
};

const safeName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const operators: Operator[] = ["eq", "neq", "lt", "lte", "gt", "gte", "is_null", "is_not_null"];
const comparisons = { eq: "=", neq: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" } as const;
const aggregates: Aggregate[] = ["count", "sum", "avg", "min", "max", "median", "quantile_90"];
const windows: WindowFunction[] = ["row_number", "rank", "dense_rank", "running_sum", "moving_avg", "lag", "share_of_total"];
const metricSlots: MetricSlot[] = ["metric_1", "metric_2", "metric_3"];
const windowSlots: WindowSlot[] = ["window_1", "window_2"];

function requestText(messages: ChatMessage[]) {
  return [...messages].reverse().find((message) => message.role === "user")?.content.trim() ?? "";
}

function focusedColumns(messages: ChatMessage[], dataset: DatasetDescriptor, columns: DatasetColumn[]) {
  return dataset.format === "duckdb" ? focusDatabaseSchema(columns, requestText(messages)) : columns.map((column) => ({ ...column, table: "dataset" }));
}

const filterShape = { type: "object", additionalProperties: false, required: ["column", "operator", "value"], properties: { column: { type: "string" }, operator: { type: "string" }, value: { type: "string" } } };

export function buildGeneralSqlSchema(messages: ChatMessage[], dataset: DatasetDescriptor, columns: DatasetColumn[]) {
  const focused = focusedColumns(messages, dataset, columns);
  const fields = focused.flatMap((column) => column.table ? [`${column.table}.${column.name}`] : []);
  const tables = [...new Set(focused.flatMap((column) => column.table ? [column.table] : []))];
  const outputReferences = [...fields, ...metricSlots, ...windowSlots];
  const sortShape = { type: "object", additionalProperties: false, required: ["field", "direction"], properties: { field: { type: "string", enum: outputReferences }, direction: { type: "string", enum: ["asc", "desc"] } } };
  return {
    type: "object", additionalProperties: false,
    required: ["action", "source", "dimensions", "filters", "aggregates", "windows", "having", "qualify", "orderBy", "limit", "explanation"],
    properties: {
      action: { type: "string", enum: ["query", "clarify", "unavailable"] },
      source: { type: "string", enum: ["", ...tables] },
      dimensions: { type: "array", maxItems: 8, items: { type: "string", enum: fields } },
      filters: { type: "array", maxItems: 12, items: { ...filterShape, properties: { ...filterShape.properties, column: { type: "string", enum: fields }, operator: { type: "string", enum: operators } } } },
      aggregates: { type: "array", maxItems: 3, items: { type: "object", additionalProperties: false, required: ["slot", "aggregate", "field", "distinct"], properties: { slot: { type: "string", enum: metricSlots }, aggregate: { type: "string", enum: aggregates }, field: { type: "string", enum: ["*", ...fields] }, distinct: { type: "boolean" } } } },
      windows: { type: "array", maxItems: 2, items: { type: "object", additionalProperties: false, required: ["slot", "function", "input", "partitionBy", "orderBy", "frameRows"], properties: { slot: { type: "string", enum: windowSlots }, function: { type: "string", enum: windows }, input: { type: "string", enum: ["", ...fields, ...metricSlots] }, partitionBy: { type: "array", maxItems: 4, items: { type: "string", enum: fields } }, orderBy: { type: "array", minItems: 1, maxItems: 4, items: sortShape }, frameRows: { type: "number" } } } },
      having: { type: "array", maxItems: 3, items: { type: "object", additionalProperties: false, required: ["metric", "operator", "value"], properties: { metric: { type: "string", enum: metricSlots }, operator: { type: "string", enum: ["eq", "neq", "lt", "lte", "gt", "gte"] }, value: { type: "number" } } } },
      qualify: { type: "array", maxItems: 2, items: { type: "object", additionalProperties: false, required: ["window", "operator", "value"], properties: { window: { type: "string", enum: windowSlots }, operator: { type: "string", enum: ["eq", "lte"] }, value: { type: "number" } } } },
      orderBy: { type: "array", maxItems: 6, items: sortShape },
      limit: { type: "number" }, explanation: { type: "string" },
    },
  };
}

export function buildGeneralSqlMessages(messages: ChatMessage[], dataset: DatasetDescriptor, columns: DatasetColumn[]): ChatMessage[] {
  const request = requestText(messages); const focused = focusedColumns(messages, dataset, columns);
  const schema = focused.map((column) => `- ${column.table}.${column.name}: ${column.type}`).join("\n");
  return [
    { role: "system", content: "You are a schema-bound relational planner, never a SQL writer. Use a pipeline of dimensions, filters, up to three aggregates, and up to two windows. metric_N and window_N are fixed compiler-owned aliases. Aggregates run before windows. Window partition and order fields must be approved schema fields or metric aliases. Use row_number/rank/dense_rank for top-per-group, running_sum for cumulative totals, moving_avg with frameRows as the number of preceding rows, lag for the previous value, and share_of_total for a grouped metric divided by its all-group total. median and quantile_90 are fixed compiler-owned aggregates. qualify filters window ranks. If the request needs recursion, unions, arbitrary expressions, ambiguous joins, or semantics outside this grammar, return clarify or unavailable. Never invent fields, joins, values, aliases, or SQL." },
    { role: "user", content: `REQUEST:\n${request}\n\nSCHEMA:\n${schema}\n\nReturn every JSON field. Use source as the relation containing the observation grain. Filters must be explicit in the request. Use * only with count. Slots must be unique and sequential. frameRows is 0 except moving_avg, where it is 1..100. Limits are 0..200. Explain the population, grain, measures, windows, and any ambiguity.` },
  ];
}

function exactKeys(value: Record<string, unknown>, expected: string[], label: string) {
  if (Object.keys(value).sort().join("\n") !== [...expected].sort().join("\n")) throw new Error(`${label} has unexpected or missing fields.`);
}

export function parseGeneralSqlPlan(raw: string): GeneralSqlPlan {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The local model returned an invalid general SQL plan.");
  const item = value as Record<string, unknown>;
  exactKeys(item, ["action", "source", "dimensions", "filters", "aggregates", "windows", "having", "qualify", "orderBy", "limit", "explanation"], "The general SQL plan");
  if (!(item.action === "query" || item.action === "clarify" || item.action === "unavailable") || typeof item.source !== "string" || !Array.isArray(item.dimensions) || !Array.isArray(item.filters) || !Array.isArray(item.aggregates) || !Array.isArray(item.windows) || !Array.isArray(item.having) || !Array.isArray(item.qualify) || !Array.isArray(item.orderBy) || typeof item.limit !== "number" || typeof item.explanation !== "string") throw new Error("The local model returned an incomplete general SQL plan.");
  if (item.action !== "query") return { action: item.action, source: "", dimensions: [], filters: [], aggregates: [], windows: [], having: [], qualify: [], orderBy: [], limit: 0, explanation: item.explanation.trim() || "The request is outside the safe relational grammar." };
  const plan = item as GeneralSqlPlan;
  const arraysBounded = plan.dimensions.length <= 8 && plan.filters.length <= 12 && plan.aggregates.length <= 3 && plan.windows.length <= 2 && plan.having.length <= 3 && plan.qualify.length <= 2 && plan.orderBy.length <= 6;
  if (!arraysBounded || !safeName.test(plan.source) || !plan.dimensions.every((field) => typeof field === "string") || !Number.isInteger(plan.limit) || plan.limit < 0 || plan.limit > 200) throw new Error("The general SQL plan exceeds safe structural limits.");
  for (const filter of plan.filters) { exactKeys(filter as unknown as Record<string, unknown>, ["column", "operator", "value"], "A general SQL filter"); if (typeof filter.column !== "string" || !operators.includes(filter.operator) || typeof filter.value !== "string") throw new Error("The general SQL plan contains an invalid filter."); }
  const metricSeen = new Set<string>();
  for (const aggregate of plan.aggregates) { exactKeys(aggregate as unknown as Record<string, unknown>, ["slot", "aggregate", "field", "distinct"], "A general SQL aggregate"); if (!metricSlots.includes(aggregate.slot) || metricSeen.has(aggregate.slot) || !aggregates.includes(aggregate.aggregate) || typeof aggregate.field !== "string" || typeof aggregate.distinct !== "boolean" || aggregate.field === "*" && aggregate.aggregate !== "count" || aggregate.distinct && aggregate.aggregate !== "count") throw new Error("The general SQL plan contains an invalid aggregate."); metricSeen.add(aggregate.slot); }
  if ([...metricSeen].join(",") !== metricSlots.slice(0, metricSeen.size).join(",")) throw new Error("General SQL metric slots must be unique and sequential.");
  const windowSeen = new Set<string>();
  for (const window of plan.windows) { exactKeys(window as unknown as Record<string, unknown>, ["slot", "function", "input", "partitionBy", "orderBy", "frameRows"], "A general SQL window"); if (!windowSlots.includes(window.slot) || windowSeen.has(window.slot) || !windows.includes(window.function) || typeof window.input !== "string" || !Array.isArray(window.partitionBy) || !Array.isArray(window.orderBy) || !window.orderBy.length || window.orderBy.length > 4 || !Number.isInteger(window.frameRows) || window.frameRows < 0 || window.frameRows > 100) throw new Error("The general SQL plan contains an invalid window."); if ((window.function === "row_number" || window.function === "rank" || window.function === "dense_rank") !== (window.input === "")) throw new Error("Ranking windows must have an empty input; value windows require an input."); if (window.function === "moving_avg" ? window.frameRows < 1 : window.frameRows !== 0) throw new Error("Only moving averages accept a positive frameRows value."); windowSeen.add(window.slot); }
  if ([...windowSeen].join(",") !== windowSlots.slice(0, windowSeen.size).join(",")) throw new Error("General SQL window slots must be unique and sequential.");
  const sorts = [...plan.orderBy, ...plan.windows.flatMap((window) => window.orderBy)];
  if (!sorts.every((sort) => sort && typeof sort.field === "string" && (sort.direction === "asc" || sort.direction === "desc"))) throw new Error("The general SQL plan contains an invalid sort.");
  if (!plan.having.every((rule) => metricSeen.has(rule.metric) && ["eq", "neq", "lt", "lte", "gt", "gte"].includes(rule.operator) && Number.isFinite(rule.value)) || !plan.qualify.every((rule) => windowSeen.has(rule.window) && (rule.operator === "eq" || rule.operator === "lte") && Number.isInteger(rule.value) && rule.value > 0 && rule.value <= 200)) throw new Error("The general SQL plan contains an invalid post-calculation condition.");
  return plan;
}

function tokens(value: string) {
  return (value.toLowerCase().replaceAll("_", " ").match(/[a-z0-9]+/g) ?? []).map((token) => {
    if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
    if (token.length > 4 && /(?:ches|shes|xes|zes|sses)$/.test(token)) return token.slice(0, -2);
    return token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token;
  });
}

function requestMentionsColumn(request: string, column: DatasetColumn) {
  const requestWords = new Set(tokens(request));
  const fieldWords = tokens(column.name).filter((token) => token !== "id" && token !== "at" && token !== "on");
  if (fieldWords.length > 0 && fieldWords.every((token) => requestWords.has(token))) return true;
  return (column.semantic?.aliases ?? []).some((alias) => {
    const aliasWords = tokens(alias).filter((token) => token !== "id" && token !== "at" && token !== "on");
    return aliasWords.length > 0 && aliasWords.every((token) => requestWords.has(token));
  });
}

function uniqueMentionedColumn(request: string, columns: DatasetColumn[], predicate: (column: DatasetColumn) => boolean, preferredTable?: string) {
  const matches = columns.filter((column) => column.table && predicate(column) && requestMentionsColumn(request, column));
  const normalizedRequest = ` ${request.toLowerCase().replace(/[^a-z0-9_]+/g, " ")} `;
  const exactMatches = matches.filter((column) => normalizedRequest.includes(` ${column.name.toLowerCase()} `));
  const preferredExact = preferredTable ? exactMatches.filter((column) => column.table === preferredTable) : [];
  if (preferredExact.length === 1) return `${preferredExact[0].table}.${preferredExact[0].name}`;
  if (exactMatches.length === 1) return `${exactMatches[0].table}.${exactMatches[0].name}`;
  const preferred = preferredTable ? matches.filter((column) => column.table === preferredTable) : [];
  const selected = preferred.length === 1 ? preferred : matches.length === 1 ? matches : null;
  return selected ? `${selected[0].table}.${selected[0].name}` : null;
}

function emptyGeneralPlan(action: GeneralSqlPlan["action"], explanation: string): GeneralSqlPlan {
  return { action, source: "", dimensions: [], filters: [], aggregates: [], windows: [], having: [], qualify: [], orderBy: [], limit: 0, explanation };
}

/**
 * Deterministically resolves common compositional forms when the request uses
 * approved schema language. Ambiguity returns null so the smaller model-backed
 * planner may try; unsupported semantics fail closed instead of producing SQL.
 */
export function resolveGeneralSqlPlan(request: string, columns: DatasetColumn[]): GeneralSqlPlan | null {
  if (/\brecursive\b/i.test(request)) return emptyGeneralPlan("unavailable", "Recursive graph traversal is outside the bounded relational grammar.");
  if (/\b(?:union|intersect|except|quartile|lead|year[- ]over[- ]year|month[- ]over[- ]month|pivot|cross[- ]tab|cohort|retention|funnel|gap(?:s)? and island(?:s)?|correlated|exists|not exists)\b/i.test(request)) {
    return emptyGeneralPlan("unavailable", "This request needs relational operations that are not yet available in the bounded analytical grammar.");
  }
  if (/\btop\b/i.test(request) && !/\btop\s+\d+\b/i.test(request)) return emptyGeneralPlan("clarify", "How many rows should be returned, and which approved measure defines top?");
  const numeric = (column: DatasetColumn) => /INT|DECIMAL|DOUBLE|REAL|FLOAT|NUMERIC/i.test(column.type) && !column.name.endsWith("_id");
  const temporal = (column: DatasetColumn) => /DATE|TIME/i.test(column.type);
  const identifier = (column: DatasetColumn) => column.name.endsWith("_id");
  const metricCandidates = columns.filter((column) => column.table && numeric(column) && requestMentionsColumn(request, column));
  const requestWords = new Set(tokens(request));
  const relationBoundMetrics = metricCandidates.filter((column) => tokens(column.table!).every((token) => requestWords.has(token)));
  let selectedMetric = relationBoundMetrics.length === 1 ? relationBoundMetrics[0] : metricCandidates.length === 1 ? metricCandidates[0] : null;
  const sharedIdentifiers = (left: string, right: string) => columns.filter((column) => column.table === left && identifier(column) && columns.some((candidate) => candidate.table === right && candidate.name === column.name));
  const directlyRelated = (left: string, right: string) => left === right || sharedIdentifiers(left, right).length === 1;
  const mentionedColumns = (predicate: (column: DatasetColumn) => boolean) => columns.filter((column) => column.table && predicate(column) && requestMentionsColumn(request, column));
  const uniqueLinkedMetric = (anchors: DatasetColumn[]) => {
    const pairs = anchors.flatMap((anchor) => metricCandidates.filter((candidate) => directlyRelated(anchor.table!, candidate.table!)).map((candidate) => ({ anchor, metric: candidate })));
    const sameTable = pairs.filter((pair) => pair.anchor.table === pair.metric.table);
    return sameTable.length === 1 ? sameTable[0] : pairs.length === 1 ? pairs[0] : null;
  };
  let metric = selectedMetric ? `${selectedMetric.table}.${selectedMetric.name}` : null;
  let source = metric?.split(".")[0] ?? "";
  const sourceId = (label?: string) => {
    const candidates = columns.filter((column) => column.table === source && identifier(column) && (!label || tokens(column.name).includes(label)) && requestMentionsColumn(request, column));
    return candidates.length === 1 ? `${source}.${candidates[0].name}` : null;
  };
  const primaryId = () => {
    const tableRoot = tokens(source).at(-1) ?? "";
    const candidates = columns.filter((column) => column.table === source && identifier(column) && tokens(column.name).includes(tableRoot));
    return candidates.length === 1 ? `${source}.${candidates[0].name}` : null;
  };
  const ascendingTie = /\blower\b.{0,30}\b(?:id|identifier)\b/i.test(request) ? "asc" as const : /\bhigher\b.{0,30}\b(?:id|identifier)\b/i.test(request) ? "desc" as const : null;
  const partitionId = () => {
    const label = request.match(/\b(?:per|for each)\s+(?:the\s+)?([a-z][a-z0-9_-]*)/i)?.[1] ?? "";
    return sourceId(tokens(label)[0]);
  };
  const temporalOrder = () => {
    const named = uniqueMentionedColumn(request, columns, temporal, source);
    if (named) return named;
    const sourceTemporal = columns.filter((column) => column.table === source && temporal(column));
    const sourceDates = sourceTemporal.filter((column) => /^DATE$/i.test(column.type));
    if (/\bdate\b/i.test(request) && sourceDates.length === 1) return `${source}.${sourceDates[0].name}`;
    if (/\b(?:date|time|chronological|chronologically)\b/i.test(request) && sourceTemporal.length === 1) return `${source}.${sourceTemporal[0].name}`;
    return null;
  };

  // Ranking language can introduce the partition before or after the limit.
  // Resolve both shapes before the global top-N rule so "within each region,
  // return the top 2 ..." cannot silently degrade into a global LIMIT 2.
  const trailingPartition = request.match(/\b(?:top|highest|leading)\s+(\d{1,3})\b.{0,180}\b(?:per|for each|within each|in each|in every)\s+([a-z][a-z0-9_-]*)/i);
  const leadingPartition = request.match(/\b(?:within|in|for)\s+(?:each|every)\s+([a-z][a-z0-9_-]*)\b.{0,180}\b(?:top|highest|leading)\s+(\d{1,3})\b/i);
  const topPerGroup = trailingPartition
    ? { limit: Number(trailingPartition[1]), group: trailingPartition[2] }
    : leadingPartition
      ? { limit: Number(leadingPartition[2]), group: leadingPartition[1] }
      : null;
  if (topPerGroup) {
    const limit = topPerGroup.limit; const groupLabel = tokens(topPerGroup.group)[0];
    const groupCandidates = columns.filter((column) => column.table && tokens(column.name).includes(groupLabel) && requestMentionsColumn(request, column));
    const groups = groupCandidates.filter((column) => !numeric(column) || column.name.endsWith("_id"));
    const linked = uniqueLinkedMetric(groups);
    if (linked) { selectedMetric = linked.metric; metric = `${linked.metric.table}.${linked.metric.name}`; source = linked.metric.table!; }
    const rankedLabel = tokens(request.match(/\b(?:top|highest|leading)\s+\d+\s+([a-z][a-z0-9_-]*)/i)?.[1] ?? "")[0];
    const entity = sourceId(rankedLabel);
    const group = linked?.anchor ?? (groups.length === 1 ? groups[0] : null);
    if (metric && source && limit > 0 && limit <= 200 && group && entity && ascendingTie) return {
      action: "query", source, dimensions: [`${group.table}.${group.name}`, entity], filters: [],
      aggregates: [{ slot: "metric_1", aggregate: "sum", field: metric, distinct: false }],
      windows: [{ slot: "window_1", function: "row_number", input: "", partitionBy: [`${group.table}.${group.name}`], orderBy: [{ field: "metric_1", direction: "desc" }, { field: entity, direction: ascendingTie }], frameRows: 0 }],
      having: [], qualify: [{ window: "window_1", operator: "lte", value: limit }], orderBy: [{ field: `${group.table}.${group.name}`, direction: "asc" }, { field: "window_1", direction: "asc" }], limit: 0,
      explanation: "Rank the grouped metric within each explicitly named partition using a deterministic tie-break.",
    };
  }

  if (/\b(?:(?:running|cumulative)\s+(?:total|sum)|running balance|accumulated total|(?:accumulates?|accumulated)\s+over\s+time)\b/i.test(request) && metric && source) {
    const partition = partitionId();
    const date = temporalOrder(); const tie = primaryId();
    if (partition && date && tie) return { action: "query", source, dimensions: [tie, partition, date, metric], filters: [], aggregates: [], windows: [{ slot: "window_1", function: "running_sum", input: metric, partitionBy: [partition], orderBy: [{ field: date, direction: "asc" }, { field: tie, direction: "asc" }], frameRows: 0 }], having: [], qualify: [], orderBy: [{ field: partition, direction: "asc" }, { field: date, direction: "asc" }, { field: tie, direction: "asc" }], limit: 0, explanation: "Calculate a deterministic cumulative total inside each requested partition." };
  }

  const moving = request.match(/\b(?:moving|rolling)\s+(?:average|mean)\b.{0,220}\b(\d{1,3})\s+(?:preceding|prior|previous) rows?\b/i)
    ?? request.match(/\b(?:moving|rolling)\s+(?:average|mean)\b.{0,220}\bcurrent\s+[a-z][a-z0-9_-]*\b.{0,80}\b(\d{1,3})\s+(?:before|preceding|prior|previous)\b/i)
    ?? (() => {
      const match = request.match(/\b(?:moving|rolling)\s+(?:average|mean)\b.{0,220}\bcurrent\s+[a-z][a-z0-9_-]*\b.{0,80}\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:before|preceding|prior|previous)\b/i);
      const word = match?.[1].toLowerCase();
      const wordCounts: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
      const value = word ? wordCounts[word] : undefined;
      return value ? [match![0], String(value)] : null;
    })();
  if (moving && metric && source) {
    const partition = partitionId();
    const date = temporalOrder(); const tie = primaryId(); const frameRows = Number(moving[1]);
    if (partition && date && tie && frameRows >= 1 && frameRows <= 100) return { action: "query", source, dimensions: [tie, partition, date, metric], filters: [], aggregates: [], windows: [{ slot: "window_1", function: "moving_avg", input: metric, partitionBy: [partition], orderBy: [{ field: date, direction: "asc" }, { field: tie, direction: "asc" }], frameRows }], having: [], qualify: [], orderBy: [{ field: partition, direction: "asc" }, { field: date, direction: "asc" }, { field: tie, direction: "asc" }], limit: 0, explanation: "Calculate the requested bounded moving average in deterministic row order." };
  }

  if (/\b(?:both\b.{0,60})?(?:total|sum)\b.{0,70}\b(?:average|mean)\b|\b(?:average|mean)\b.{0,70}\b(?:and|plus)\b.{0,20}\b(?:total|sum)\b/i.test(request)) {
    const groups = mentionedColumns((column) => !numeric(column) && !temporal(column) && !identifier(column));
    const linked = uniqueLinkedMetric(groups);
    if (linked) { selectedMetric = linked.metric; metric = `${linked.metric.table}.${linked.metric.name}`; source = linked.metric.table!; }
    const group = linked ? `${linked.anchor.table}.${linked.anchor.name}` : uniqueMentionedColumn(request, columns, (column) => !numeric(column) && !temporal(column) && !identifier(column));
    if (group && metric && source) return { action: "query", source, dimensions: [group], filters: [], aggregates: [{ slot: "metric_1", aggregate: "sum", field: metric, distinct: false }, { slot: "metric_2", aggregate: "avg", field: metric, distinct: false }], windows: [], having: [], qualify: [], orderBy: [{ field: group, direction: "asc" }], limit: 0, explanation: "Return both explicitly requested aggregates at the requested group grain." };
  }

  if (/\bmedian\b/i.test(request) && metric && source) return { action: "query", source, dimensions: [], filters: [], aggregates: [{ slot: "metric_1", aggregate: "median", field: metric, distinct: false }], windows: [], having: [], qualify: [], orderBy: [], limit: 0, explanation: "Calculate the requested median over the explicitly named measure." };

  if (/\b(?:90th percentile|percentile\s+90|p90)\b/i.test(request) && metric && source) return { action: "query", source, dimensions: [], filters: [], aggregates: [{ slot: "metric_1", aggregate: "quantile_90", field: metric, distinct: false }], windows: [], having: [], qualify: [], orderBy: [], limit: 0, explanation: "Calculate the fixed 90th percentile over the explicitly named measure." };

  if (/\bshare of (?:(?:the )?total|all)\b|\bpercent of (?:(?:the )?total|all)\b/i.test(request)) {
    const entities = mentionedColumns(identifier);
    const linked = uniqueLinkedMetric(entities);
    if (linked) { metric = `${linked.metric.table}.${linked.metric.name}`; source = linked.metric.table!; }
    const entity = linked ? `${source}.${linked.anchor.name}` : sourceId(tokens(request.match(/\beach\s+([a-z][a-z0-9_-]*)/i)?.[1] ?? "")[0]);
    if (entity && metric && source) return { action: "query", source, dimensions: [entity], filters: [], aggregates: [{ slot: "metric_1", aggregate: "sum", field: metric, distinct: false }], windows: [{ slot: "window_1", function: "share_of_total", input: "metric_1", partitionBy: [], orderBy: [{ field: entity, direction: "asc" }], frameRows: 0 }], having: [], qualify: [], orderBy: [{ field: entity, direction: "asc" }], limit: 0, explanation: "Divide each grouped total by the all-group total using a compiler-owned window calculation." };
  }

  if (/\b(?:lag|previous)\b/i.test(request)) {
    const dates = mentionedColumns(temporal);
    const exactDate = metric && source ? uniqueMentionedColumn(request, columns, temporal, source) : null;
    const linked = exactDate ? null : uniqueLinkedMetric(dates);
    if (linked) { metric = `${linked.metric.table}.${linked.metric.name}`; source = linked.metric.table!; }
    const event = sourceId(tokens(request.match(/\b(?:every|each|show)\s+(?:the\s+)?([a-z][a-z0-9_-]*)\s+(?:id|identifier)/i)?.[1] ?? "")[0]) ?? primaryId();
    const entityCandidates = columns.filter((column) => column.table === source && identifier(column) && `${source}.${column.name}` !== event && requestMentionsColumn(request, column));
    const entity = entityCandidates.length === 1 ? `${source}.${entityCandidates[0].name}` : null;
    const chosenDate = linked?.anchor ?? (dates.length === 1 ? dates[0] : null);
    const date = exactDate ?? (chosenDate?.table === source ? `${source}.${chosenDate.name}` : temporalOrder());
    if (event && entity && date && metric && source) return { action: "query", source, dimensions: [event], filters: [], aggregates: [], windows: [{ slot: "window_1", function: "lag", input: metric, partitionBy: [entity], orderBy: [{ field: date, direction: "asc" }, { field: event, direction: "asc" }], frameRows: 0 }], having: [], qualify: [], orderBy: [{ field: entity, direction: "asc" }, { field: date, direction: "asc" }, { field: event, direction: "asc" }], limit: 0, explanation: "Return the previous measure inside each explicitly named entity partition in deterministic date and identifier order." };
  }

  const having = request.match(/\b(?:total|sum)\b.{0,80}\b(?:is\s+)?(greater than|more than|above|less than|below|at least|at most)\s+(-?\d+(?:\.\d+)?)/i);
  if (having) {
    const groups = mentionedColumns(identifier);
    const linked = uniqueLinkedMetric(groups);
    if (linked) { metric = `${linked.metric.table}.${linked.metric.name}`; source = linked.metric.table!; }
    const requestedGroup = tokens(request.match(/\b(?:return|show|list|find)\s+(?:the\s+)?([a-z][a-z0-9_-]*)\s+(?:id|identifier)/i)?.[1] ?? "")[0];
    const group = linked?.anchor.table === source ? `${source}.${linked.anchor.name}` : sourceId(requestedGroup);
    const phrase = having[1].toLowerCase();
    const operator = phrase === "at least" ? "gte" as const : phrase === "at most" ? "lte" as const : /greater|more|above/.test(phrase) ? "gt" as const : "lt" as const;
    if (group && metric && source) return { action: "query", source, dimensions: [group], filters: [], aggregates: [{ slot: "metric_1", aggregate: "sum", field: metric, distinct: false }], windows: [], having: [{ metric: "metric_1", operator, value: Number(having[2]) }], qualify: [], orderBy: [{ field: "metric_1", direction: /\b(?:descending|highest)\b/i.test(request) ? "desc" : "asc" }], limit: 0, explanation: "Apply the explicit threshold to the grouped aggregate selected through the requested entity relationship." };
  }

  const first = request.match(/\b(?:first|top|highest|leading)\s+(\d{1,3})\b/i);
  if (first && metric && source) {
    const entity = sourceId(tokens(request.match(/\b(?:first|top|highest|leading)\s+\d+\s+([a-z][a-z0-9_-]*)/i)?.[1] ?? "")[0]); const limit = Number(first[1]);
    if (entity && ascendingTie && limit > 0 && limit <= 200) return { action: "query", source, dimensions: [entity, metric], filters: [], aggregates: [], windows: [], having: [], qualify: [], orderBy: [{ field: metric, direction: /\b(?:highest|top|leading)\b/i.test(request) ? "desc" : "asc" }, { field: entity, direction: ascendingTie }], limit, explanation: "Order the requested rows by the explicit measure and deterministic identifier tie-break." };
  }
  return null;
}

export function auditGeneralSqlPlan(plan: GeneralSqlPlan, request: string, columns: DatasetColumn[]): GeneralSqlPlan {
  if (plan.action !== "query") return plan;
  const requestTokens = new Set(tokens(request));
  const mentioned = (field: string) => {
    if (!field.includes(".")) return true;
    const column = reference(field, columns);
    const fieldTokens = tokens(column.name).filter((token) => token !== "id");
    return fieldTokens.length > 0 && fieldTokens.some((token) => requestTokens.has(token));
  };
  const semanticFields = [...plan.dimensions, ...plan.aggregates.flatMap((aggregate) => aggregate.field === "*" ? [] : [aggregate.field]), ...plan.windows.flatMap((window) => [...window.partitionBy, ...(window.input.includes(".") ? [window.input] : []), ...window.orderBy.flatMap((sort) => sort.field.includes(".") ? [sort.field] : [])])];
  if (semanticFields.some((field) => !mentioned(field))) return { ...plan, action: "clarify", explanation: "Which approved fields define the requested dimensions, measures, and ordering?" };
  for (const filter of plan.filters) {
    reference(filter.column, columns);
    const valueTokens = tokens(filter.value);
    if (filter.operator !== "is_null" && filter.operator !== "is_not_null" && (!valueTokens.length || !valueTokens.every((token) => requestTokens.has(token)))) return { ...plan, action: "clarify", explanation: "Which explicit filter value should constrain the requested population?" };
  }
  return plan;
}

function quote(value: string) { return `"${value.replaceAll('"', '""')}"`; }
function reference(value: string, columns: DatasetColumn[]) { const [table, name, extra] = value.split("."); if (extra || !safeName.test(table) || !safeName.test(name) || !columns.some((column) => column.table === table && column.name === name)) throw new Error(`Unavailable general SQL field: ${value}`); return { table, name, sql: `${quote(table)}.${quote(name)}`, type: columns.find((column) => column.table === table && column.name === name)!.type }; }
function literal(value: string, type: string) { if (/BOOL/i.test(type)) { if (!/^(?:true|false)$/i.test(value)) throw new Error("Invalid Boolean general SQL filter."); return value.toUpperCase(); } if (/INT|DECIMAL|DOUBLE|REAL|FLOAT|NUMERIC/i.test(type)) { if (!/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error("Invalid numeric general SQL filter."); return value; } return `'${value.replaceAll("'", "''")}'`; }

function relationGraph(columns: DatasetColumn[]) { const tables = [...new Set(columns.flatMap((column) => column.table ? [column.table] : []))]; const graph = new Map<string, Array<{ table: string; key: string }>>(); for (const left of tables) for (const right of tables) { if (left >= right) continue; const shared = columns.find((column) => column.table === left && column.name.endsWith("_id") && columns.some((candidate) => candidate.table === right && candidate.name === column.name)); if (!shared) continue; graph.set(left, [...(graph.get(left) ?? []), { table: right, key: shared.name }]); graph.set(right, [...(graph.get(right) ?? []), { table: left, key: shared.name }]); } return graph; }
function joinPath(graph: ReturnType<typeof relationGraph>, start: string, target: string) { const queue: Array<{ table: string; edges: Array<{ table: string; key: string }> }> = [{ table: start, edges: [] }]; const seen = new Set([start]); while (queue.length) { const current = queue.shift()!; if (current.table === target) return current.edges; for (const edge of graph.get(current.table) ?? []) if (!seen.has(edge.table)) { seen.add(edge.table); queue.push({ table: edge.table, edges: [...current.edges, edge] }); } } throw new Error(`No approved general SQL join path reaches ${target}.`); }

export function compileGeneralSqlPlan(plan: GeneralSqlPlan, columns: DatasetColumn[]): SqlProposal {
  if (plan.action !== "query") return { action: plan.action, query: "", explanation: plan.explanation };
  const fields = new Set([...plan.dimensions, ...plan.filters.map((filter) => filter.column), ...plan.aggregates.flatMap((aggregate) => aggregate.field === "*" ? [] : [aggregate.field]), ...plan.windows.flatMap((window) => [...window.partitionBy, ...(window.input.includes(".") ? [window.input] : []), ...window.orderBy.flatMap((sort) => sort.field.includes(".") ? [sort.field] : [])]), ...plan.orderBy.flatMap((sort) => sort.field.includes(".") ? [sort.field] : [])]);
  const refs = [...fields].map((field) => reference(field, columns));
  if (!safeName.test(plan.source) || !columns.some((column) => column.table === plan.source)) throw new Error("Unavailable general SQL source.");
  const graph = relationGraph(columns); const joined = new Set([plan.source]); const joins: string[] = [];
  for (const target of new Set(refs.map((ref) => ref.table))) { if (joined.has(target)) continue; const starts = [...joined].flatMap((start) => { try { return [{ start, path: joinPath(graph, start, target) }]; } catch { return []; } }); if (starts.length !== 1) throw new Error(`The general SQL join path to ${target} is unavailable or ambiguous.`); for (const edge of starts[0].path) if (!joined.has(edge.table)) { joins.push(`JOIN ${quote(edge.table)} USING (${quote(edge.key)})`); joined.add(edge.table); } }
  const leaves = plan.dimensions.map((field) => reference(field, columns).name); if (new Set(leaves).size !== leaves.length) throw new Error("General SQL dimensions must have unique output names.");
  const filterSql = plan.filters.map((filter) => { const ref = reference(filter.column, columns); return filter.operator === "is_null" || filter.operator === "is_not_null" ? `${ref.sql} IS ${filter.operator === "is_not_null" ? "NOT " : ""}NULL` : `${ref.sql} ${comparisons[filter.operator]} ${literal(filter.value, ref.type)}`; });
  const aggregateExpression = (aggregate: GeneralSqlPlan["aggregates"][number]) => { const operand = aggregate.field === "*" ? "*" : reference(aggregate.field, columns).sql; const distinct = aggregate.distinct && operand !== "*" ? "DISTINCT " : ""; return aggregate.aggregate === "quantile_90" ? `QUANTILE_CONT(${operand}, 0.9)` : aggregate.aggregate === "median" ? `MEDIAN(${operand})` : `${aggregate.aggregate.toUpperCase()}(${distinct}${operand})`; };
  const aggregateSql = plan.aggregates.map((aggregate) => `${aggregateExpression(aggregate)} AS ${quote(aggregate.slot)}`);
  const hiddenWindowFields = [...new Set(plan.windows.flatMap((window) => [window.input, ...window.partitionBy, ...window.orderBy.map((sort) => sort.field)]).filter((field) => field.includes(".") && !plan.dimensions.includes(field)))];
  if (plan.aggregates.length && hiddenWindowFields.length) throw new Error("Grouped windows may use only grouped dimensions and compiler-owned metric aliases.");
  const select = [...plan.dimensions.map((field) => reference(field, columns).sql), ...hiddenWindowFields.map((field) => reference(field, columns).sql), ...aggregateSql];
  if (!select.length) throw new Error("The general SQL plan has no output.");
  const having = plan.having.map((rule) => { const aggregate = plan.aggregates.find((item) => item.slot === rule.metric)!; return `${aggregateExpression(aggregate)} ${comparisons[rule.operator]} ${rule.value}`; });
  let query = `WITH ${quote("base_result")} AS (\n  SELECT ${select.join(", ")}\n  FROM ${quote(plan.source)}${joins.length ? `\n  ${joins.join("\n  ")}` : ""}${filterSql.length ? `\n  WHERE ${filterSql.join(" AND ")}` : ""}${plan.aggregates.length && plan.dimensions.length ? `\n  GROUP BY ${plan.dimensions.map((field) => reference(field, columns).sql).join(", ")}` : ""}${having.length ? `\n  HAVING ${having.join(" AND ")}` : ""}\n)`;
  const baseNames = [...leaves, ...hiddenWindowFields.map((field) => reference(field, columns).name), ...plan.aggregates.map((aggregate) => aggregate.slot)];
  const selectedOutputNames = [...leaves, ...plan.aggregates.map((aggregate) => aggregate.slot)];
  if (plan.windows.length) {
    const available = new Set(baseNames);
    const outputRef = (field: string) => { const leaf = field.includes(".") ? reference(field, columns).name : field; if (!available.has(leaf)) throw new Error(`Window input ${field} is not available after the base stage.`); return quote(leaf); };
    const windowSql = plan.windows.map((window) => { const partition = window.partitionBy.length ? `PARTITION BY ${window.partitionBy.map(outputRef).join(", ")} ` : ""; const order = `ORDER BY ${window.orderBy.map((sort) => `${outputRef(sort.field)} ${sort.direction.toUpperCase()}`).join(", ")}`; const expression = window.function === "row_number" ? "ROW_NUMBER()" : window.function === "rank" ? "RANK()" : window.function === "dense_rank" ? "DENSE_RANK()" : window.function === "running_sum" ? `SUM(${outputRef(window.input)})` : window.function === "moving_avg" ? `AVG(${outputRef(window.input)})` : window.function === "lag" ? `LAG(${outputRef(window.input)})` : `100.0 * ${outputRef(window.input)} / NULLIF(SUM(${outputRef(window.input)}) OVER (), 0)`; const frame = window.function === "running_sum" ? " ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW" : window.function === "moving_avg" ? ` ROWS BETWEEN ${window.frameRows} PRECEDING AND CURRENT ROW` : ""; const over = window.function === "share_of_total" ? "" : ` OVER (${partition}${order}${frame})`; return `${expression}${over} AS ${quote(window.slot)}`; });
    query += `,\n${quote("window_result")} AS (\n  SELECT *, ${windowSql.join(", ")} FROM ${quote("base_result")}\n)`;
    selectedOutputNames.push(...plan.windows.map((window) => window.slot));
    baseNames.push(...plan.windows.map((window) => window.slot));
  }
  const finalRelation = plan.windows.length ? "window_result" : "base_result";
  const available = new Set(baseNames); const finalRef = (field: string) => { const leaf = field.includes(".") ? reference(field, columns).name : field; if (!available.has(leaf)) throw new Error(`Final output reference ${field} is unavailable.`); return quote(leaf); };
  const qualify = plan.qualify.map((rule) => `${finalRef(rule.window)} ${rule.operator === "eq" ? "=" : "<="} ${rule.value}`);
  query += `\nSELECT ${selectedOutputNames.map(quote).join(", ")} FROM ${quote(finalRelation)}${qualify.length ? ` WHERE ${qualify.join(" AND ")}` : ""}${plan.orderBy.length ? ` ORDER BY ${plan.orderBy.map((sort) => `${finalRef(sort.field)} ${sort.direction.toUpperCase()}`).join(", ")}` : ""}${plan.limit ? ` LIMIT ${plan.limit}` : ""}`;
  return { action: "query", query: validateSqlPreviewQuery(query), explanation: plan.explanation || "Run the validated relational plan." };
}

export function shouldUseGeneralSqlPlan(request: string) {
  if (/\b(?:average|mean)\b.{0,40}\btotal\b.{0,80}\b(?:per|by|for each)\b/i.test(request)) return false;
  return /\b(?:running|cumulative|accumulates? over time|accumulated total|rolling (?:average|mean)|moving (?:average|mean)|row number|rank|top|highest \d+|leading \d+|first \d+ .+ highest|dense rank|previous .{0,80}(?:same|per|each)|both .{0,60}(?:total|sum)|(?:total|sum) .{0,70}(?:average|mean)|(?:average|mean) .{0,70}(?:total|sum)|multiple (?:totals|aggregates|metrics)|(?:total|sum) .+ (?:greater|more|above|less|below|at least|at most)|recursive|union|intersect|except|median|percentile|quartile|lag|lead|year[- ]over[- ]year|month[- ]over[- ]month|share of (?:(?:the )?total|all)|percent of (?:(?:the )?total|all)|pivot|cross[- ]tab|cohort|retention|funnel|gap(?:s)? and island(?:s)?|correlated|exists|not exists)\b/i.test(request);
}

export function generalSqlOutputColumns(plan: GeneralSqlPlan) {
  return [...plan.dimensions.map((field) => field.split(".").at(-1)!), ...plan.aggregates.map((aggregate) => aggregate.slot), ...plan.windows.map((window) => window.slot)];
}
