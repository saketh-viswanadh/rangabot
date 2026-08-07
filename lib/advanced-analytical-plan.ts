import type { ChatMessage } from "./providers/types.ts";
import type { ApprovedDataset } from "./datasets.ts";
import type { DatasetColumn } from "./sql-runtime.ts";
import type { SqlProposal } from "./sql-proposals.ts";
import { focusDatabaseSchema } from "./sql-proposals.ts";
import { validateSqlPreviewQuery } from "./sql-confirmations.ts";
import { resolveAnalyticalSemanticRoles } from "./analytical-semantic-roles.ts";

type Aggregate = "count" | "sum" | "avg" | "min" | "max";
type OuterAggregate = Exclude<Aggregate, "count">;
type Operation = "ratio" | "conditional_rate" | "distinct_count" | "duration_average" | "threshold_count" | "period_growth" | "per_entity_average" | "aggregate_over_groups" | "anti_join";
type Operator = "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "is_null" | "is_not_null";
export type Filter = { column: string; operator: Operator; value: string };

export type AnalyticalPlanAudit = {
  plan: AdvancedAnalyticalPlan;
  decisions: Array<{ field: string; action: "kept" | "removed" | "replaced" | "clarified"; reason: string }>;
};

export type AdvancedAnalyticalPlan = {
  action: "query" | "clarify" | "unavailable";
  operation: Operation;
  source: string;
  metric: string;
  secondaryMetric: string;
  entity: string;
  groupField: string;
  innerAggregate: Aggregate;
  outerAggregate: OuterAggregate;
  distinct: boolean;
  dimensions: string[];
  startField: string;
  endField: string;
  dateField: string;
  relatedField: string;
  filters: Filter[];
  numeratorFilters: Filter[];
  denominatorFilters: Filter[];
  threshold: number;
  decimals: number;
  firstStart: string;
  firstEnd: string;
  secondStart: string;
  secondEnd: string;
  explanation: string;
};

const operations: Operation[] = ["ratio", "conditional_rate", "distinct_count", "duration_average", "threshold_count", "period_growth", "per_entity_average", "aggregate_over_groups", "anti_join"];
const aggregates: Aggregate[] = ["count", "sum", "avg", "min", "max"];
const outerAggregates: OuterAggregate[] = ["sum", "avg", "min", "max"];
const operators: Operator[] = ["eq", "neq", "lt", "lte", "gt", "gte", "is_null", "is_not_null"];
const safeName = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const filterShape = { type: "object", additionalProperties: false, required: ["column", "operator", "value"], properties: { column: { type: "string" }, operator: { type: "string" }, value: { type: "string" } } };
const baseSchema = {
  type: "object", additionalProperties: false,
  required: ["action", "operation", "source", "metric", "secondaryMetric", "entity", "groupField", "innerAggregate", "outerAggregate", "distinct", "dimensions", "startField", "endField", "dateField", "relatedField", "filters", "numeratorFilters", "denominatorFilters", "threshold", "decimals", "firstStart", "firstEnd", "secondStart", "secondEnd", "explanation"],
  properties: {
    action: { type: "string" }, operation: { type: "string" }, source: { type: "string" }, metric: { type: "string" }, secondaryMetric: { type: "string" }, entity: { type: "string" }, groupField: { type: "string" }, innerAggregate: { type: "string" }, outerAggregate: { type: "string" }, distinct: { type: "boolean" }, dimensions: { type: "array", items: { type: "string" } },
    startField: { type: "string" }, endField: { type: "string" }, dateField: { type: "string" }, relatedField: { type: "string" },
    filters: { type: "array", items: filterShape }, numeratorFilters: { type: "array", items: filterShape }, denominatorFilters: { type: "array", items: filterShape },
    threshold: { type: "number" }, decimals: { type: "number" }, firstStart: { type: "string" }, firstEnd: { type: "string" }, secondStart: { type: "string" }, secondEnd: { type: "string" }, explanation: { type: "string" },
  },
};

function requestText(messages: ChatMessage[]) { return [...messages].reverse().find((message) => message.role === "user")?.content.trim() ?? ""; }
function focusedColumns(messages: ChatMessage[], dataset: ApprovedDataset, columns: DatasetColumn[]) {
  return dataset.format === "duckdb" ? focusDatabaseSchema(columns, requestText(messages)) : columns.map((column) => ({ ...column, table: "dataset" }));
}

export function buildAdvancedAnalyticalSchema(messages: ChatMessage[], dataset: ApprovedDataset, columns: DatasetColumn[]) {
  const focused = focusedColumns(messages, dataset, columns);
  const fields = focused.flatMap((column) => column.table ? [`${column.table}.${column.name}`] : []);
  const tables = [...new Set(focused.flatMap((column) => column.table ? [column.table] : []))];
  const schema = structuredClone(baseSchema);
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  properties.action.enum = ["query", "clarify", "unavailable"];
  properties.operation.enum = operations;
  properties.innerAggregate.enum = aggregates;
  properties.outerAggregate.enum = outerAggregates;
  properties.source.enum = ["", ...tables];
  for (const name of ["metric", "secondaryMetric", "entity", "groupField", "startField", "endField", "dateField", "relatedField"]) properties[name].enum = name === "metric" || name === "secondaryMetric" ? ["", "*", ...fields] : ["", ...fields];
  (properties.dimensions.items as Record<string, unknown>).enum = fields;
  for (const name of ["filters", "numeratorFilters", "denominatorFilters"]) {
    const filterProperties = ((properties[name].items as Record<string, unknown>).properties as Record<string, Record<string, unknown>>);
    filterProperties.column.enum = fields; filterProperties.operator.enum = operators;
  }
  return schema;
}

export function buildAdvancedAnalyticalMessages(messages: ChatMessage[], dataset: ApprovedDataset, columns: DatasetColumn[]): ChatMessage[] {
  const request = requestText(messages); const focused = focusedColumns(messages, dataset, columns);
  const schema = focused.map((column) => `- ${column.table}.${column.name}: ${column.type}`).join("\n");
  return [
    { role: "system", content: "You are a domain-neutral local analytical planner, not a SQL writer. Map the request to exactly one generic operation using only enum-approved schema fields. ratio divides an aggregate metric by a secondary aggregate metric; secondaryMetric * means the source row count. conditional_rate divides rows matching numeratorFilters by rows matching denominatorFilters. distinct_count counts unique entity values after explicit filters. duration_average averages elapsed time between startField and endField. threshold_count counts entities whose grouped row count reaches threshold. period_growth compares summed metric over two explicit date ranges. per_entity_average sums metric per entity then averages those sums. aggregate_over_groups first applies innerAggregate to metric for each groupField, then applies outerAggregate across those group values; use distinct only with inner count. anti_join returns source entities with no relatedField match. If the operation, population, grain, measure, or required field is ambiguous or unrepresentable, return clarify or unavailable. Never infer causal effects, forecasts, or unsupported statistics." },
    { role: "user", content: `REQUEST:\n${request}\n\nSCHEMA:\n${schema}\n\nReturn every required JSON field. Copy table.column values exactly. Empty unused field references and arrays are required; use count, avg and false as neutral defaults for unused innerAggregate, outerAggregate and distinct fields. For aggregate_over_groups, groupField defines the grain, metric defines the inner measure (* only for row count), innerAggregate runs within each group, and outerAggregate runs across groups. Filter values must come from the request. Dates use YYYY-MM-DD with half-open ranges. Explain the population, grain and calculation or the exact ambiguity without claiming a result.` },
  ];
}

export function shouldUseAdvancedAnalyticalPlan(request: string) {
  return /\b(?:distinct|unique|divided by|ratio|percentage|average (?:duration|elapsed|number|count|.+ time)|time between|how long|at least \d+|growth|average .+ per |never \w+|without (?:a |any )?match)\b/i.test(request);
}

export function parseAdvancedAnalyticalPlan(raw: string): AdvancedAnalyticalPlan {
  const value: unknown = JSON.parse(raw); if (!value || typeof value !== "object") throw new Error("The local model returned an invalid advanced analytical plan.");
  const item = value as Record<string, unknown>;
  if (!(["query", "clarify", "unavailable"] as unknown[]).includes(item.action) || !operations.includes(item.operation as Operation)
    || typeof item.source !== "string" || typeof item.metric !== "string" || typeof item.secondaryMetric !== "string" || typeof item.entity !== "string" || typeof item.groupField !== "string"
    || !aggregates.includes(item.innerAggregate as Aggregate) || !outerAggregates.includes(item.outerAggregate as OuterAggregate) || typeof item.distinct !== "boolean" || !Array.isArray(item.dimensions)
    || typeof item.startField !== "string" || typeof item.endField !== "string" || typeof item.dateField !== "string" || typeof item.relatedField !== "string"
    || !Array.isArray(item.filters) || !Array.isArray(item.numeratorFilters) || !Array.isArray(item.denominatorFilters)
    || typeof item.threshold !== "number" || typeof item.decimals !== "number" || typeof item.firstStart !== "string" || typeof item.firstEnd !== "string" || typeof item.secondStart !== "string" || typeof item.secondEnd !== "string" || typeof item.explanation !== "string") throw new Error("The local model returned an incomplete advanced analytical plan.");
  const validFilters = (items: unknown[]) => items.every((filter) => {
    if (!filter || typeof filter !== "object") return false;
    const candidate = filter as Record<string, unknown>;
    return typeof candidate.column === "string" && operators.includes(candidate.operator as Operator) && typeof candidate.value === "string";
  });
  if (!item.dimensions.every((field) => typeof field === "string") || !validFilters(item.filters) || !validFilters(item.numeratorFilters) || !validFilters(item.denominatorFilters)
    || !Number.isInteger(item.threshold) || item.threshold < 0 || item.threshold > 10_000 || !Number.isInteger(item.decimals) || item.decimals < 0 || item.decimals > 6) throw new Error("The local model returned an unsafe advanced analytical plan.");
  if (item.action !== "query" && !item.explanation.trim()) throw new Error("The local model returned an unexplained analytical boundary.");
  return item as AdvancedAnalyticalPlan;
}

function words(value: string) {
  return value.toLowerCase().replaceAll("_", " ").match(/[a-z0-9]+/g)?.map((word) => {
    if (word.length > 4 && word.endsWith("ied")) return `${word.slice(0, -3)}y`;
    if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
    if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
    if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
    if (word.length > 4 && word.endsWith("s")) return word.slice(0, -1);
    return word;
  }) ?? [];
}

function columnFor(field: string, columns: DatasetColumn[]) {
  const [table, name, extra] = field.split(".");
  if (extra || !table || !name) return undefined;
  return columns.find((column) => column.table === table && column.name === name);
}

function fieldEvidence(field: string, request: string) {
  const requestWords = new Set(words(request));
  const fieldWords = words(field).filter((word) => word !== "id");
  return fieldWords.filter((word) => requestWords.has(word)).length;
}

function inferRequestedIdentifier(request: string, columns: DatasetColumn[], excluded = "") {
  const candidates = columns.filter((column) => column.table && column.name.endsWith("_id") && `${column.table}.${column.name}` !== excluded).map((column) => {
    const field = `${column.table}.${column.name}`;
    const root = column.name.slice(0, -3);
    const canonicalTable = column.table === root || column.table === `${root}s`;
    return { field, score: fieldEvidence(field, request) + (canonicalTable ? 1 : 0) };
  }).sort((left, right) => right.score - left.score || left.field.localeCompare(right.field));
  if (!candidates[0] || candidates[0].score <= 0 || candidates[0].score === candidates[1]?.score) return null;
  return candidates[0].field;
}

function containsWordSequence(haystack: string[], needle: string[]) {
  return needle.length > 0 && haystack.some((_, index) => needle.every((word, offset) => haystack[index + offset] === word));
}

function relationNamedInRequest(table: string, request: string) {
  return containsWordSequence(words(request), words(table));
}

function namesBareDistinctPopulation(table: string, request: string) {
  const tableWords = new Set(words(table));
  const allowed = new Set(["how", "many", "number", "count", "of", "distinct", "unique", "the", "there", "are", "is", "exist", "in", "total"]);
  const requestWords = words(request);
  return relationNamedInRequest(table, request)
    && requestWords.every((word) => tableWords.has(word) || allowed.has(word));
}

function relationDistance(graph: ReturnType<typeof relationGraph>, source: string, target: string) {
  if (source === target) return 0;
  try { return path(graph, source, target).length; }
  catch { return Number.POSITIVE_INFINITY; }
}

function inferObservationSource(plan: AdvancedAnalyticalPlan, request: string, entity: DatasetColumn, columns: DatasetColumn[]) {
  const filterTables = [...new Set(plan.filters.flatMap((filter) => filter.column.split(".")[0] || []))];
  const graph = relationGraph(columns);
  const candidates = [...new Set(columns.filter((column) => column.table && column.name === entity.name).map((column) => column.table!))].map((table) => {
    // The counted entity is expected to be named in the request, so its
    // canonical table is not treated as evidence for the qualifying relation.
    const qualifyingMention = table !== entity.table && relationNamedInRequest(table, request) ? 12 : 0;
    const filterProximity = filterTables.reduce((score, filterTable) => {
      const distance = relationDistance(graph, table, filterTable);
      return score + (distance === 0 ? 8 : distance === 1 ? 5 : distance === 2 ? 2 : 0);
    }, 0);
    const barePopulationMention = table === entity.table && namesBareDistinctPopulation(table, request) ? 4 : 0;
    return { table, score: qualifyingMention + filterProximity + barePopulationMention };
  }).sort((left, right) => right.score - left.score || left.table.localeCompare(right.table));
  // When the identifier exists on both an entity relation and one or more fact
  // relations, absence of qualifying evidence is genuine ambiguity. Counting
  // the canonical entity relation would silently include entities with no
  // qualifying observation.
  if (!candidates[0] || candidates[0].score <= 0 || candidates[0].score === candidates[1]?.score) return null;
  return candidates[0].table;
}

function sharedRoleSource(fields: string[], columns: DatasetColumn[]) {
  const names = fields.map((field) => field.split(".").at(-1)).filter((name): name is string => Boolean(name));
  const tables = [...new Set(columns.flatMap((column) => column.table ? [column.table] : []))];
  const candidates = tables.filter((table) => names.every((name) => columns.some((column) => column.table === table && column.name === name)));
  return candidates.length === 1 ? candidates[0] : null;
}

function fieldOnSource(field: string, source: string, columns: DatasetColumn[]) {
  const name = field.split(".").at(-1);
  return name && columns.some((column) => column.table === source && column.name === name) ? `${source}.${name}` : field;
}

function primaryIdentifierForTable(table: string, columns: DatasetColumn[]) {
  const tableWords = words(table);
  const identifiers = columns.filter((column) => column.table === table && column.name.endsWith("_id"));
  const exact = identifiers.filter((column) => {
    const root = words(column.name.slice(0, -3));
    return root.length === tableWords.length && root.every((word, index) => word === tableWords[index]);
  });
  return (exact.length === 1 ? exact[0] : identifiers.length === 1 ? identifiers[0] : undefined);
}

function requestContainsLiteral(request: string, value: string) {
  if (/[{}[\]<>]|\$[a-z_]/i.test(value)) return false;
  const normalizedRequest = ` ${words(request).join(" ")} `;
  const normalizedValue = words(value).join(" ");
  return Boolean(normalizedValue) && normalizedRequest.includes(` ${normalizedValue} `);
}

function requestNegatesLiteral(request: string, value: string) {
  const requestTokens = words(request);
  const valueTokens = words(value);
  if (!valueTokens.length) return false;
  const index = requestTokens.findIndex((_, offset) => valueTokens.every((word, inner) => requestTokens[offset + inner] === word));
  if (index < 0) return false;
  return negatedBefore(requestTokens, index);
}

function negatedBefore(requestTokens: string[], index: number) {
  const preceding = requestTokens.slice(Math.max(0, index - 3), index);
  return preceding.some((word) => ["not", "no", "without", "exclude", "exclud", "except", "non"].includes(word))
    || preceding.some((word, offset) => word === "other" && preceding[offset + 1] === "than");
}

function namesWholePopulationForRate(request: string, relation: string) {
  if (!/\b(?:percent|percentage|share)\b/i.test(request)
    || /\b(?:growth|change|increase|decrease|ratio|divided by)\b/i.test(request)
    || /\b(?:not|without|excluding|except|non[-\s])\b/i.test(request)) return false;
  const requestTokens = words(request);
  const relationTokens = words(relation);
  const relationIndex = requestTokens.findIndex((_, index) => relationTokens.every((word, offset) => requestTokens[index + offset] === word));
  const rateIndex = requestTokens.findLastIndex((word, index) => index < relationIndex && ["percent", "percentage", "share"].includes(word));
  if (relationIndex < 0 || rateIndex < 0) return false;
  const populationScope = requestTokens.slice(rateIndex + 1, relationIndex);
  if (!populationScope.every((word) => ["of", "the", "all"].includes(word))) return false;
  const predicate = requestTokens[relationIndex + relationTokens.length];
  const next = predicate === "that" ? requestTokens[relationIndex + relationTokens.length + 1] : predicate;
  return ["have", "has", "with", "are", "is", "were", "was"].includes(next ?? "");
}

function requestedBoolean(field: string, request: string) {
  const label = field.split(".").at(-1)?.replace(/^(?:is|has)_/, "").replaceAll("_", " ") ?? "";
  const labelTokens = words(label);
  if (!labelTokens.length) return undefined;
  const requestTokens = words(request);
  let positive = false;
  let negative = false;
  for (let index = 0; index < requestTokens.length; index += 1) {
    if (labelTokens.every((word, offset) => requestTokens[index + offset] === word)) {
      if (negatedBefore(requestTokens, index)) negative = true;
      else positive = true;
    }
  }
  if (labelTokens.length === 1) {
    negative ||= requestTokens.some((word) => ["in", "un", "non"].some((prefix) => word === `${prefix}${labelTokens[0]}`));
  }
  if (positive === negative) return undefined;
  return negative ? "false" : "true";
}

function explicitBooleanRateCondition(request: string, relation: string, columns: DatasetColumn[]): Filter | null {
  const matches = columns.filter((column) => column.table === relation && /BOOL/i.test(column.type)).flatMap((column) => {
    const value = requestedBoolean(`${relation}.${column.name}`, request);
    return value === undefined ? [] : [{ column: `${relation}.${column.name}`, operator: "eq" as const, value }];
  });
  return matches.length === 1 ? matches[0] : null;
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function monthRanges(request: string) {
  const names = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  return [...request.matchAll(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(20\d{2})\b/gi)].map((match) => {
    const month = names.indexOf(match[1].toLowerCase()); const year = Number(match[2]);
    const start = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
    const end = new Date(Date.UTC(year, month + 1, 1)).toISOString().slice(0, 10);
    return { start, end };
  });
}

/**
 * Applies current-request precedence to a model-proposed analytical plan.
 * The model interprets language; trusted code removes unsupported additions,
 * validates operation invariants, and asks rather than silently guessing.
 */
export function auditAdvancedAnalyticalPlan(plan: AdvancedAnalyticalPlan, request: string, columns: DatasetColumn[]): AnalyticalPlanAudit {
  const decisions: AnalyticalPlanAudit["decisions"] = [];
  if (plan.action !== "query") return { plan, decisions };
  const cleanFilters = (filters: Filter[], field: string) => filters.filter((filter) => {
    const column = columnFor(filter.column, columns);
    if (!column) { decisions.push({ field, action: "removed", reason: `Unavailable field ${filter.column}.` }); return false; }
    if (filter.operator === "is_null" || filter.operator === "is_not_null") {
      const supported = /\b(?:null|missing|unresolved|without|no)\b/i.test(request) && fieldEvidence(filter.column, request) > 0;
      if (!supported) decisions.push({ field, action: "removed", reason: "Null condition was not supported by the current request." });
      return supported;
    }
    const boolean = /BOOL/i.test(column.type) ? requestedBoolean(filter.column, request) : undefined;
    const literalIsExplicit = filter.value.trim() !== "" && requestContainsLiteral(request, filter.value);
    // An explicit user-supplied categorical value is sufficient provenance for
    // a schema-bound text filter chosen by the model. Numeric filters retain the
    // stricter field-name requirement so a threshold cannot become an ID filter.
    const categorical = /CHAR|TEXT|STRING|ENUM/i.test(column.type);
    const negatedLiteral = requestNegatesLiteral(request, filter.value);
    const categoricalOperatorMatches = categorical && literalIsExplicit
      && ((negatedLiteral && filter.operator === "neq") || (!negatedLiteral && filter.operator === "eq"));
    const booleanMatches = boolean !== undefined && filter.operator === "eq";
    const scalarMatches = !categorical && !/BOOL/i.test(column.type) && !negatedLiteral
      && literalIsExplicit && fieldEvidence(filter.column, request) > 0;
    const supported = booleanMatches || categoricalOperatorMatches || scalarMatches;
    if (!supported) decisions.push({ field, action: "removed", reason: "Filter field and value were not both supported by the current request." });
    else if (boolean !== undefined && filter.value.toLowerCase() !== boolean) {
      decisions.push({ field, action: "replaced", reason: "Boolean value was aligned with the current request." }); filter.value = boolean;
    }
    return supported;
  });

  const normalized: AdvancedAnalyticalPlan = {
    ...plan,
    dimensions: [],
    filters: cleanFilters(plan.filters.map((filter) => ({ ...filter })), "filters"),
    numeratorFilters: cleanFilters(plan.numeratorFilters.map((filter) => ({ ...filter })), "numeratorFilters"),
    denominatorFilters: cleanFilters(plan.denominatorFilters.map((filter) => ({ ...filter })), "denominatorFilters"),
  };
  const clarify = (reason: string): AnalyticalPlanAudit => {
    decisions.push({ field: "action", action: "clarified", reason });
    return { plan: { ...normalized, action: "clarify", explanation: reason }, decisions };
  };
  if (plan.operation === "conditional_rate" && normalized.denominatorFilters.length !== plan.denominatorFilters.length) {
    return clarify("The requested denominator scope could not be verified against the approved schema and current request.");
  }
  if (plan.dimensions.length) decisions.push({ field: "dimensions", action: "removed", reason: "This operation has a fixed output grain and does not accept model-added dimensions." });

  const roles = resolveAnalyticalSemanticRoles(request, columns);
  const groupedCountAverage = /\b(?:average|mean)\b.{0,80}\b(?:number|count)\b.{0,80}\b(?:per|by|for each)\b/i.test(request);
  if (/\b(?:ratio|divided by)\b/i.test(request) && roles.measure.confidence === "high") {
    normalized.operation = "ratio";
    normalized.metric = roles.measure.value!;
    if (roles.secondaryMeasure.confidence === "high") normalized.secondaryMetric = roles.secondaryMeasure.value!;
    else if (roles.denominatorRelation.confidence === "high" && normalized.metric.startsWith(`${roles.denominatorRelation.value}.`)) normalized.secondaryMetric = "*";
    else return clarify("Which approved measure or source row count defines the ratio denominator?");
    normalized.source = normalized.metric.split(".")[0];
    decisions.push({ field: "operation", action: "replaced", reason: "The request explicitly identifies a ratio numerator and denominator." });
  } else if (groupedCountAverage) {
    if (normalized.operation !== "aggregate_over_groups") decisions.push({ field: "operation", action: "replaced", reason: "The request explicitly asks for an average across grouped counts." });
    normalized.operation = "aggregate_over_groups";
    normalized.groupField = roles.group.confidence === "high" ? roles.group.value! : normalized.groupField || plan.dimensions[0] || "";
    const inferredEntity = roles.countTarget.confidence === "high" ? roles.countTarget.value : inferRequestedIdentifier(request, columns, normalized.groupField);
    normalized.entity = inferredEntity ?? normalized.entity;
    const source = normalized.entity && normalized.groupField ? sharedRoleSource([normalized.entity, normalized.groupField], columns) : null;
    if (source) {
      normalized.source = source;
      normalized.entity = fieldOnSource(normalized.entity, source, columns);
      normalized.groupField = fieldOnSource(normalized.groupField, source, columns);
    }
    normalized.metric = normalized.entity || (normalized.metric === "*" ? "" : normalized.metric);
    normalized.innerAggregate = "count";
    normalized.outerAggregate = "avg";
    normalized.distinct = normalized.distinct || Boolean(normalized.entity);
  } else if (/\b(?:average|mean)\b.{0,40}\btotal\b.{0,80}\b(?:per|by|for each)\b/i.test(request)) {
    if (roles.measure.confidence !== "high" || roles.group.confidence !== "high") return clarify("Which approved measure and entity define the requested average of totals?");
    normalized.operation = "per_entity_average";
    normalized.metric = roles.measure.value!;
    const metricTable = normalized.metric.split(".")[0];
    normalized.entity = fieldOnSource(roles.group.value!, metricTable, columns);
    normalized.source = metricTable;
    decisions.push({ field: "operation", action: "replaced", reason: "The request explicitly asks to average a summed measure across entities." });
  } else if (/\b(?:average|mean)\b.{0,50}\b(?:duration|elapsed|time between)\b/i.test(request)
    && roles.startTime.confidence === "high" && roles.endTime.confidence === "high") {
    normalized.operation = "duration_average";
    normalized.startField = roles.startTime.value!;
    normalized.endField = roles.endTime.value!;
    normalized.source = normalized.startField.split(".")[0];
    decisions.push({ field: "operation", action: "replaced", reason: "The request explicitly identifies both duration endpoints." });
  } else if (/\b(?:distinct|unique)\b/i.test(request) && /\b(?:count|how many|number)\b/i.test(request)) {
    if (normalized.operation !== "distinct_count") decisions.push({ field: "operation", action: "replaced", reason: "The request explicitly asks for a distinct population count." });
    normalized.operation = "distinct_count";
    normalized.entity = roles.countTarget.confidence === "high" ? roles.countTarget.value! : normalized.entity || (normalized.metric === "*" ? "" : normalized.metric);
  } else if (/\bhow many\b.{0,60}\bat least\s+\d+\b/i.test(request)
    && roles.thresholdEntity.confidence === "high" && roles.thresholdRelation.confidence === "high") {
    const threshold = request.match(/\bat least\s+(\d+)\b/i);
    normalized.operation = "threshold_count";
    normalized.source = roles.thresholdRelation.value!;
    normalized.entity = fieldOnSource(roles.thresholdEntity.value!, normalized.source, columns);
    normalized.threshold = Number(threshold?.[1] ?? 0);
    decisions.push({ field: "operation", action: "replaced", reason: "The request explicitly identifies an entity, observation relation and positive threshold." });
  } else if (/\b(?:never|without)\b/i.test(request)
    && roles.unmatchedEntity.confidence === "high" && roles.relatedRelation.confidence === "high") {
    const entity = columnFor(roles.unmatchedEntity.value!, columns);
    const relatedId = primaryIdentifierForTable(roles.relatedRelation.value!, columns);
    if (!entity || !relatedId) return clarify("Which approved entity and related relation define the unmatched population?");
    normalized.operation = "anti_join";
    normalized.source = entity.table!;
    normalized.entity = roles.unmatchedEntity.value!;
    normalized.relatedField = `${relatedId.table}.${relatedId.name}`;
    decisions.push({ field: "operation", action: "replaced", reason: "The request explicitly identifies an entity population without a related observation." });
  } else if (/\bgrowth\s+(?:in|of|from|between)\b/i.test(request) && roles.measure.confidence === "high") {
    normalized.operation = "period_growth";
    normalized.metric = roles.measure.value!;
    normalized.source = normalized.metric.split(".")[0];
    if (roles.dateField.confidence === "high") normalized.dateField = roles.dateField.value!;
    decisions.push({ field: "operation", action: "replaced", reason: "The request explicitly identifies a growth measure and comparison periods." });
  }

  const requireColumn = (field: keyof AdvancedAnalyticalPlan, type: RegExp, label: string) => {
    const value = normalized[field]; const column = typeof value === "string" ? columnFor(value, columns) : undefined;
    return column && type.test(column.type) ? column : clarify(`${label} is not unambiguously available in the approved schema.`);
  };
  const numeric = /INT|DECIMAL|DOUBLE|REAL|FLOAT|NUMERIC/i; const temporal = /DATE|TIME/i;
  let anchor: DatasetColumn | undefined;
  if (normalized.operation === "ratio") {
    const first = requireColumn("metric", numeric, "The numerator metric"); if ("plan" in first) return first;
    if (normalized.secondaryMetric !== "*") { const second = requireColumn("secondaryMetric", numeric, "The denominator metric"); if ("plan" in second) return second; }
    anchor = first;
  } else if (normalized.operation === "duration_average") {
    const start = requireColumn("startField", temporal, "The duration start field"); if ("plan" in start) return start;
    const end = requireColumn("endField", temporal, "The duration end field"); if ("plan" in end) return end;
    if (start.table !== end.table) return clarify("The duration start and end fields must describe the same approved relation."); anchor = start;
  } else if (normalized.operation === "distinct_count") {
    const entity = columnFor(normalized.entity, columns);
    if (!entity || fieldEvidence(normalized.entity, request) === 0) return clarify("Which approved field identifies the distinct population to count?");
    anchor = entity;
  } else if (normalized.operation === "threshold_count") {
    const entity = columnFor(normalized.entity, columns); if (!entity || !normalized.entity.endsWith("_id") || normalized.threshold <= 0) return clarify("The grouped entity and positive threshold are not unambiguous.");
    normalized.filters = normalized.filters.filter((filter) => !(filter.column.endsWith("_id") && Number(filter.value) === normalized.threshold)); anchor = entity;
  } else if (normalized.operation === "period_growth") {
    const metric = requireColumn("metric", numeric, "The growth metric"); if ("plan" in metric) return metric; anchor = metric;
    const ranges = monthRanges(request);
    if (ranges.length === 2) {
      [normalized.firstStart, normalized.firstEnd] = [ranges[0].start, ranges[0].end];
      [normalized.secondStart, normalized.secondEnd] = [ranges[1].start, ranges[1].end];
      decisions.push({ field: "periods", action: "replaced", reason: "Calendar boundaries were deterministically derived from the current request." });
    }
    const metricTableDates = columns.filter((column) => column.table === metric.table && temporal.test(column.type));
    const mentioned = metricTableDates.filter((column) => fieldEvidence(`${column.table}.${column.name}`, request) > 0);
    const dateOnly = metricTableDates.filter((column) => /^DATE$/i.test(column.type));
    const chosen = mentioned.length === 1 ? mentioned[0] : dateOnly.length === 1 ? dateOnly[0] : columnFor(normalized.dateField, columns);
    if (!chosen || !temporal.test(chosen.type)) return clarify("Which date field should define the comparison periods?");
    normalized.dateField = `${chosen.table}.${chosen.name}`;
    if (![normalized.firstStart, normalized.firstEnd, normalized.secondStart, normalized.secondEnd].every(validDate)) return clarify("The requested comparison periods could not be converted into valid calendar dates.");
  } else if (normalized.operation === "per_entity_average") {
    const metric = requireColumn("metric", numeric, "The averaged metric"); if ("plan" in metric) return metric;
    const entity = columnFor(normalized.entity, columns); if (!entity || !normalized.entity.endsWith("_id")) return clarify("Which entity should define the per-entity average?"); anchor = metric;
  } else if (normalized.operation === "aggregate_over_groups") {
    const group = columnFor(normalized.groupField, columns);
    if (!group || fieldEvidence(normalized.groupField, request) === 0) return clarify("Which approved field defines each group?");
    if (normalized.metric === "*") {
      if (normalized.innerAggregate !== "count" || normalized.distinct) return clarify("A row measure supports only a non-distinct inner count.");
      anchor = group;
    } else {
      const metric = columnFor(normalized.metric, columns);
      if (!metric || fieldEvidence(normalized.metric, request) === 0) return clarify("Which approved field defines the value measured within each group?");
      if (normalized.innerAggregate !== "count" && !numeric.test(metric.type)) return clarify("The inner aggregate requires a numeric measure.");
      if (normalized.distinct && normalized.innerAggregate !== "count") return clarify("Distinct applies only to an inner count.");
      anchor = metric;
    }
  } else if (normalized.operation === "anti_join") {
    const entity = columnFor(normalized.entity, columns); const related = columnFor(normalized.relatedField, columns);
    if (!entity || !related || entity.table === related.table || !normalized.entity.endsWith("_id")) return clarify("The unmatched entity and related relation are not unambiguous.");
    normalized.source = entity.table!; anchor = entity;
  } else if (normalized.operation === "conditional_rate") {
    if (!normalized.numeratorFilters.length) return clarify("Which explicit condition defines the numerator?");
    anchor = columnFor(normalized.numeratorFilters[0].column, columns);
  }
  if (anchor?.table && normalized.operation !== "anti_join" && normalized.source !== anchor.table) {
    normalized.source = anchor.table; decisions.push({ field: "source", action: "replaced", reason: "The source was aligned with the validated operation fields." });
  }
  if (normalized.operation === "distinct_count") {
    const entity = columnFor(normalized.entity, columns);
    if (entity) {
      const source = inferObservationSource(normalized, request, entity, columns);
      if (!source) return clarify("Which approved relation defines the distinct population after applying the requested conditions?");
      if (normalized.source !== source) decisions.push({ field: "source", action: "replaced", reason: "The source was aligned with the schema relation named by the request and model-selected fields." });
      normalized.source = source;
      normalized.entity = fieldOnSource(normalized.entity, source, columns);
    }
  }
  return { plan: normalized, decisions };
}

export function normalizeAdvancedAnalyticalPlan(plan: AdvancedAnalyticalPlan, request: string, columns: DatasetColumn[]) {
  return auditAdvancedAnalyticalPlan(plan, request, columns).plan;
}

/**
 * Recovers from malformed model JSON only when the current request and schema
 * independently resolve every required role. It never uses fixture knowledge,
 * dataset values, or a model-specific branch.
 */
export function recoverAdvancedAnalyticalPlan(request: string, columns: DatasetColumn[]): AdvancedAnalyticalPlan | null {
  const roles = resolveAnalyticalSemanticRoles(request, columns);
  const base: AdvancedAnalyticalPlan = {
    action: "query", operation: "ratio", source: "", metric: "", secondaryMetric: "", entity: "", groupField: "",
    innerAggregate: "count", outerAggregate: "avg", distinct: false, dimensions: [], startField: "", endField: "",
    dateField: "", relatedField: "", filters: [], numeratorFilters: [], denominatorFilters: [], threshold: 0, decimals: 2,
    firstStart: "", firstEnd: "", secondStart: "", secondEnd: "", explanation: "Compile the roles explicitly resolved from the current request and approved schema.",
  };
  if (/\b(?:average|mean)\b.{0,50}\b(?:duration|elapsed|time between)\b/i.test(request)
    && roles.startTime.confidence === "high" && roles.endTime.confidence === "high") {
    return { ...base, operation: "duration_average", source: roles.startTime.value!.split(".")[0], startField: roles.startTime.value!, endField: roles.endTime.value! };
  }
  if (/\b(?:average|mean)\b.{0,80}\b(?:number|count)\b.{0,80}\b(?:per|by|for each)\b/i.test(request)
    && roles.countTarget.confidence === "high" && roles.group.confidence === "high") {
    const source = sharedRoleSource([roles.countTarget.value!, roles.group.value!], columns);
    if (!source) return null;
    return { ...base, operation: "aggregate_over_groups", source, metric: fieldOnSource(roles.countTarget.value!, source, columns), entity: fieldOnSource(roles.countTarget.value!, source, columns), groupField: fieldOnSource(roles.group.value!, source, columns), distinct: true };
  }
  if (/\b(?:average|mean)\b.{0,40}\btotal\b.{0,80}\b(?:per|by|for each)\b/i.test(request)
    && roles.measure.confidence === "high" && roles.group.confidence === "high") {
    const source = roles.measure.value!.split(".")[0];
    return { ...base, operation: "per_entity_average", source, metric: roles.measure.value!, entity: fieldOnSource(roles.group.value!, source, columns) };
  }
  if (/\b(?:ratio|divided by)\b/i.test(request) && roles.measure.confidence === "high") {
    const source = roles.measure.value!.split(".")[0];
    const secondary = roles.secondaryMeasure.confidence === "high" ? roles.secondaryMeasure.value
      : roles.denominatorRelation.confidence === "high" && roles.denominatorRelation.value === source ? "*" : null;
    return secondary ? { ...base, operation: "ratio", source, metric: roles.measure.value!, secondaryMetric: secondary } : null;
  }
  if (/\bhow many\b.{0,60}\bat least\s+\d+\b/i.test(request)
    && roles.thresholdEntity.confidence === "high" && roles.thresholdRelation.confidence === "high") {
    const source = roles.thresholdRelation.value!; const threshold = Number(request.match(/\bat least\s+(\d+)\b/i)?.[1] ?? 0);
    return threshold > 0 ? { ...base, operation: "threshold_count", source, entity: fieldOnSource(roles.thresholdEntity.value!, source, columns), threshold } : null;
  }
  if (/\b(?:never|without)\b/i.test(request)
    && roles.unmatchedEntity.confidence === "high" && roles.relatedRelation.confidence === "high") {
    const entity = columnFor(roles.unmatchedEntity.value!, columns); const related = primaryIdentifierForTable(roles.relatedRelation.value!, columns);
    return entity && related ? { ...base, operation: "anti_join", source: entity.table!, entity: roles.unmatchedEntity.value!, relatedField: `${related.table}.${related.name}` } : null;
  }
  if (/\bgrowth\b/i.test(request) && roles.measure.confidence === "high") {
    return { ...base, operation: "period_growth", source: roles.measure.value!.split(".")[0], metric: roles.measure.value!, dateField: roles.dateField.confidence === "high" ? roles.dateField.value! : "" };
  }
  if (roles.populationRelation.confidence === "high"
    && namesWholePopulationForRate(request, roles.populationRelation.value!)) {
    const source = roles.populationRelation.value!;
    const booleanCondition = explicitBooleanRateCondition(request, source, columns);
    return { ...base, operation: "conditional_rate", source, numeratorFilters: booleanCondition ? [booleanCondition] : [] };
  }
  if (/\b(?:distinct|unique)\b/i.test(request) && roles.countTarget.confidence === "high") {
    const entity = columnFor(roles.countTarget.value!, columns);
    return entity ? { ...base, operation: "distinct_count", source: entity.table!, entity: roles.countTarget.value! } : null;
  }
  return null;
}

function quote(name: string) { return `"${name.replaceAll('"', '""')}"`; }
function reference(value: string, columns: DatasetColumn[]) {
  const [table, column, extra] = value.split(".");
  if (extra || !safeName.test(table) || !safeName.test(column)) throw new Error(`Invalid advanced analytical field: ${value}`);
  const schema = columns.find((item) => item.table === table && item.name === column); if (!schema) throw new Error(`Unavailable advanced analytical field: ${value}`);
  return { table, column, type: schema.type, sql: `${quote(table)}.${quote(column)}` };
}
function literal(value: string, type: string) {
  if (/BOOL/i.test(type)) { if (!/^(?:true|false)$/i.test(value)) throw new Error("Invalid Boolean filter value."); return value.toUpperCase(); }
  if (/(?:INT|DECIMAL|DOUBLE|REAL|FLOAT|NUMERIC)/i.test(type)) { if (!/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error("Invalid numeric filter value."); return value; }
  return `'${value.replaceAll("'", "''")}'`;
}

function relationGraph(columns: DatasetColumn[]) {
  const tables = [...new Set(columns.flatMap((column) => column.table ? [column.table] : []))]; const graph = new Map<string, Array<{ table: string; key: string }>>();
  for (const left of tables) for (const right of tables) { if (left >= right) continue; const names = new Set(columns.filter((column) => column.table === left && column.name.endsWith("_id")).map((column) => column.name)); const shared = columns.find((column) => column.table === right && names.has(column.name)); if (!shared) continue; graph.set(left, [...(graph.get(left) ?? []), { table: right, key: shared.name }]); graph.set(right, [...(graph.get(right) ?? []), { table: left, key: shared.name }]); }
  return graph;
}
function path(graph: ReturnType<typeof relationGraph>, start: string, target: string) {
  const queue: Array<{ table: string; edges: Array<{ table: string; key: string }> }> = [{ table: start, edges: [] }]; const seen = new Set([start]);
  while (queue.length) { const current = queue.shift()!; if (current.table === target) return current.edges; for (const edge of graph.get(current.table) ?? []) if (!seen.has(edge.table)) { seen.add(edge.table); queue.push({ table: edge.table, edges: [...current.edges, edge] }); } }
  throw new Error(`No approved join path reaches ${target}.`);
}
function fromClause(source: string, refs: ReturnType<typeof reference>[], columns: DatasetColumn[]) {
  if (!safeName.test(source) || !columns.some((column) => column.table === source)) throw new Error("Unavailable advanced analytical source.");
  const graph = relationGraph(columns); const joined = new Set([source]); const joins: string[] = [];
  for (const target of new Set(refs.map((ref) => ref.table))) { if (joined.has(target)) continue; const start = [...joined].find((table) => { try { path(graph, table, target); return true; } catch { return false; } }); if (!start) throw new Error(`No approved join path reaches ${target}.`); for (const edge of path(graph, start, target)) if (!joined.has(edge.table)) { joins.push(`JOIN ${quote(edge.table)} USING (${quote(edge.key)})`); joined.add(edge.table); } }
  return [`FROM ${quote(source)}`, ...joins].join("\n");
}
function where(filters: Filter[], columns: DatasetColumn[]) {
  const comparisons: Record<Exclude<Operator, "is_null" | "is_not_null">, string> = { eq: "=", neq: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" };
  return filters.map((filter) => { const ref = reference(filter.column, columns); return filter.operator === "is_null" || filter.operator === "is_not_null" ? `${ref.sql} IS ${filter.operator === "is_not_null" ? "NOT " : ""}NULL` : `${ref.sql} ${comparisons[filter.operator]} ${literal(filter.value, ref.type)}`; });
}

export function compileAdvancedAnalyticalPlan(plan: AdvancedAnalyticalPlan, columns: DatasetColumn[]): SqlProposal {
  if (plan.action !== "query") return { action: plan.action, query: "", explanation: plan.explanation };
  if (plan.operation === "conditional_rate" && !plan.numeratorFilters.length) throw new Error("A conditional rate requires one explicit numerator condition.");
  const operationValues: Record<Operation, string[]> = {
    ratio: [plan.metric, plan.secondaryMetric],
    conditional_rate: [...plan.numeratorFilters.map((filter) => filter.column), ...plan.denominatorFilters.map((filter) => filter.column)],
    distinct_count: [plan.entity],
    duration_average: [plan.startField, plan.endField],
    threshold_count: [plan.entity],
    period_growth: [plan.metric, plan.dateField],
    per_entity_average: [plan.metric, plan.entity],
    aggregate_over_groups: [plan.metric, plan.groupField],
    anti_join: [plan.entity, plan.relatedField],
  };
  const usedValues = [...operationValues[plan.operation], ...plan.filters.map((filter) => filter.column)].filter((field) => Boolean(field) && field !== "*");
  const refs = usedValues.map((field) => reference(field, columns)); const relation = fromClause(plan.source, refs, columns); const baseWhere = where(plan.filters, columns); const suffix = baseWhere.length ? `\nWHERE ${baseWhere.join(" AND ")}` : ""; const round = (value: string) => plan.decimals ? `ROUND(${value}, ${plan.decimals})` : value;
  let query: string;
  if (plan.operation === "ratio") { const a = reference(plan.metric, columns); const denominator = plan.secondaryMetric === "*" ? "COUNT(*)" : `SUM(${reference(plan.secondaryMetric, columns).sql})`; query = `SELECT ${round(`SUM(${a.sql}) / NULLIF(${denominator}, 0)`)} AS ${quote("ratio")}\n${relation}${suffix}`; }
  else if (plan.operation === "conditional_rate") { const denominator = where(plan.denominatorFilters, columns); const numerator = where([...plan.denominatorFilters, ...plan.numeratorFilters], columns); query = `SELECT ${round(`100.0 * COUNT(*) FILTER (WHERE ${numerator.join(" AND ")}) / NULLIF(COUNT(*) FILTER (WHERE ${denominator.join(" AND ") || "TRUE"}), 0)`)} AS ${quote("rate_pct")}\n${relation}${suffix}`; }
  else if (plan.operation === "distinct_count") { const entity = reference(plan.entity, columns); query = `SELECT COUNT(DISTINCT ${entity.sql}) AS ${quote("distinct_count")}\n${relation}${suffix}`; }
  else if (plan.operation === "duration_average") { const start = reference(plan.startField, columns); const end = reference(plan.endField, columns); query = `SELECT ${round(`AVG(DATE_DIFF('minute', ${start.sql}, ${end.sql})) / 60.0`)} AS ${quote("average_duration_hours")}\n${relation}${suffix}`; }
  else if (plan.operation === "threshold_count") { const entity = reference(plan.entity, columns); query = `SELECT COUNT(*) AS ${quote("matching_entities")} FROM (SELECT ${entity.sql}\n${relation}${suffix}\nGROUP BY ${entity.sql}\nHAVING COUNT(*) >= ${plan.threshold}) AS ${quote("qualified")}`; }
  else if (plan.operation === "period_growth") { const metric = reference(plan.metric, columns); const date = reference(plan.dateField, columns); query = `WITH ${quote("periods")} AS (SELECT SUM(${metric.sql}) FILTER (WHERE ${date.sql} >= DATE '${plan.firstStart}' AND ${date.sql} < DATE '${plan.firstEnd}') AS ${quote("first_value")}, SUM(${metric.sql}) FILTER (WHERE ${date.sql} >= DATE '${plan.secondStart}' AND ${date.sql} < DATE '${plan.secondEnd}') AS ${quote("second_value")}\n${relation}${suffix}) SELECT ${round(`100.0 * (${quote("second_value")} - ${quote("first_value")}) / NULLIF(${quote("first_value")}, 0)`)} AS ${quote("growth_pct")} FROM ${quote("periods")}`; }
  else if (plan.operation === "per_entity_average") { const metric = reference(plan.metric, columns); const entity = reference(plan.entity, columns); query = `SELECT ${round(`AVG(${quote("entity_value")})`)} AS ${quote("average_per_entity")} FROM (SELECT ${entity.sql}, SUM(${metric.sql}) AS ${quote("entity_value")}\n${relation}${suffix}\nGROUP BY ${entity.sql}) AS ${quote("per_entity")}`; }
  else if (plan.operation === "aggregate_over_groups") {
    const group = reference(plan.groupField, columns);
    const operand = plan.metric === "*" ? "*" : reference(plan.metric, columns).sql;
    const inner = plan.innerAggregate === "count" ? `COUNT(${plan.distinct && operand !== "*" ? `DISTINCT ${operand}` : operand})` : `${plan.innerAggregate.toUpperCase()}(${operand})`;
    query = `SELECT ${round(`${plan.outerAggregate.toUpperCase()}(${quote("group_value")})`)} AS ${quote("aggregate_over_groups")} FROM (SELECT ${group.sql}, ${inner} AS ${quote("group_value")}\n${relation}${suffix}\nGROUP BY ${group.sql}) AS ${quote("group_values")}`;
  }
  else {
    const entity = reference(plan.entity, columns); const related = reference(plan.relatedField, columns);
    const shared = columns.find((column) => column.table === entity.table && column.name.endsWith("_id") && columns.some((candidate) => candidate.table === related.table && candidate.name === column.name));
    if (!shared || plan.source !== entity.table) throw new Error("The anti-join requires a direct approved entity relationship.");
    query = `SELECT ${entity.sql}\nFROM ${quote(entity.table)}\nLEFT JOIN ${quote(related.table)} USING (${quote(shared.name)})${suffix ? `${suffix} AND` : "\nWHERE"} ${related.sql} IS NULL\nORDER BY ${entity.sql}`;
  }
  return { action: "query", query: validateSqlPreviewQuery(query), explanation: plan.explanation || "Run the validated advanced analytical operation." };
}
