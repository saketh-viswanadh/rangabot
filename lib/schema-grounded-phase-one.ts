import type { AdvancedAnalyticalPlan } from "./advanced-analytical-plan.ts";
import type { AnalyticalGroundingExecutor } from "./analytical-filter-grounding.ts";
import type { GeneralSqlPlan } from "./general-sql-plan.ts";
import type { DatasetColumn } from "./sql-runtime.ts";

type SemanticKind = "identifier" | "measure" | "category" | "temporal" | "boolean";

type CatalogColumn = Readonly<{
  column: DatasetColumn;
  field: string;
  kind: SemanticKind;
  fieldTokens: readonly string[];
  tableTokens: readonly string[];
  aliases: ReadonlySet<string>;
}>;

export type PhaseOneGroundingEvidence = Readonly<{
  operation: string;
  source: string;
  fields: readonly string[];
  categoricalValues: readonly Readonly<{ field: string; value: string }>[];
  confidence: "deterministic";
}>;

export type SchemaGroundedPhaseOnePlan =
  | Readonly<{ kind: "general"; plan: GeneralSqlPlan; grounding: PhaseOneGroundingEvidence }>
  | Readonly<{ kind: "advanced"; plan: AdvancedAnalyticalPlan; grounding: PhaseOneGroundingEvidence }>;

const numericType = /INT|DECIMAL|DOUBLE|REAL|FLOAT|NUMERIC/i;
const temporalType = /DATE|TIME/i;
const textType = /CHAR|TEXT|STRING|ENUM/i;
const safeName = /^[A-Za-z_][A-Za-z0-9_]*$/;

const irregularSingular = new Map([
  ["people", "person"], ["children", "child"], ["men", "man"], ["women", "woman"],
  ["indices", "index"], ["analyses", "analysis"], ["statuses", "status"],
]);

function singular(value: string) {
  const irregular = irregularSingular.get(value);
  if (irregular) return irregular;
  if (value.length > 4 && value.endsWith("ies")) return `${value.slice(0, -3)}y`;
  if (value.length > 4 && /(?:ches|shes|xes|zes|sses)$/.test(value)) return value.slice(0, -2);
  if (value.length > 3 && value.endsWith("s") && !value.endsWith("ss")) return value.slice(0, -1);
  return value;
}

function tokens(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
    ?.map(singular) ?? [];
}

function phraseTokensPresent(needles: readonly string[], haystack: ReadonlySet<string>) {
  return needles.length > 0 && needles.every((token) => haystack.has(token));
}

function kindOf(column: DatasetColumn): SemanticKind {
  if (column.name.endsWith("_id")) return "identifier";
  if (/BOOL/i.test(column.type)) return "boolean";
  if (temporalType.test(column.type)) return "temporal";
  if (numericType.test(column.type)) return "measure";
  return "category";
}

function semanticAliases(column: DatasetColumn, kind: SemanticKind) {
  const aliases = new Set(tokens([column.name, column.semantic?.description ?? "", ...(column.semantic?.aliases ?? [])].join(" ")));
  const name = column.name.toLocaleLowerCase();
  if (kind === "identifier") for (const alias of ["id", "identifier", "entity", "record"]) aliases.add(alias);
  if (kind === "measure") {
    aliases.add("measure"); aliases.add("metric"); aliases.add("value");
    if (/(?:amount|cost|charge|revenue|income|price|fee|pay|value)/.test(name)) {
      for (const alias of ["amount", "money", "spend", "spending", "cost", "revenue", "value"]) aliases.add(alias);
    }
    if (/(?:count|units?|hours?|minutes?|days?|seats?|visitors?|attendees?|messages?|questions?|findings?|stops?)/.test(name)) {
      for (const alias of ["quantity", "number", "volume", "units"]) aliases.add(alias);
    }
  }
  if (kind === "category") {
    if (/(?:state|status|outcome|result)/.test(name)) for (const alias of ["state", "status", "outcome", "result"]) aliases.add(alias);
    if (/(?:name|label|title)/.test(name)) for (const alias of ["name", "label", "title"]) aliases.add(alias);
  }
  if (kind === "temporal") for (const alias of ["date", "time", "when", "period"]) aliases.add(alias);
  return aliases;
}

export function buildAnalyticalSemanticCatalog(columns: DatasetColumn[]): readonly CatalogColumn[] {
  return columns.flatMap((column) => {
    if (!column.table || !safeName.test(column.table) || !safeName.test(column.name)) return [];
    const kind = kindOf(column);
    return [{
      column,
      field: `${column.table}.${column.name}`,
      kind,
      fieldTokens: tokens(column.name).filter((token) => token !== "id"),
      tableTokens: tokens([column.table, column.semantic?.tableDescription ?? "", ...(column.semantic?.tableAliases ?? [])].join(" ")),
      aliases: semanticAliases(column, kind),
    }];
  });
}

function relationScores(request: string, catalog: readonly CatalogColumn[]) {
  const requestTokens = new Set(tokens(request));
  const tables = [...new Set(catalog.map((item) => item.column.table!))];
  return tables.map((table) => {
    const representative = catalog.find((item) => item.column.table === table)?.column;
    const tableTokens = tokens([table, representative?.semantic?.tableDescription ?? "", ...(representative?.semantic?.tableAliases ?? [])].join(" "));
    const overlap = tableTokens.filter((token) => requestTokens.has(token)).length;
    const complete = phraseTokensPresent(tableTokens, requestTokens);
    const fields = catalog.filter((item) => item.column.table === table);
    const observationShape = fields.some((item) => item.kind === "measure") && fields.some((item) => item.kind === "temporal");
    return { table, score: overlap * 10 + (complete ? 12 : 0) + (observationShape ? 1 : 0), complete, observationShape };
  }).filter((item) => item.score > 0).sort((left, right) => right.score - left.score || right.table.length - left.table.length || left.table.localeCompare(right.table));
}

function uniqueBest<T extends { score: number }>(candidates: readonly T[], minimum = 1): T | null {
  if (!candidates[0] || candidates[0].score < minimum) return null;
  return candidates[0].score > (candidates[1]?.score ?? -1) ? candidates[0] : null;
}

function fieldScores(request: string, catalog: readonly CatalogColumn[], kind: SemanticKind, preferredTable?: string) {
  const requestTokens = new Set(tokens(request));
  return catalog.filter((item) => item.kind === kind && (!preferredTable || item.column.table === preferredTable)).map((item) => {
    const fieldOverlap = item.fieldTokens.filter((token) => requestTokens.has(token)).length;
    const aliasOverlap = [...item.aliases].filter((token) => requestTokens.has(token)).length;
    const semanticAliasOverlap = [...item.aliases].filter((token) => !item.fieldTokens.includes(token) && requestTokens.has(token)).length;
    const tableNamed = phraseTokensPresent(item.tableTokens, requestTokens);
    const exactField = item.fieldTokens.length > 0 && phraseTokensPresent(item.fieldTokens, requestTokens);
    const contextName = item.fieldTokens.includes("name") && tableNamed && requestTokens.has("name");
    if (kind === "measure" && item.fieldTokens.length > 1 && fieldOverlap > 0 && !exactField && semanticAliasOverlap === 0) return { item, score: 0 };
    const score = fieldOverlap * 12 + aliasOverlap * 5 + (exactField ? 12 : 0) + (tableNamed ? 5 + item.tableTokens.length * 4 : 0) + (contextName ? 15 : 0);
    return { item, score };
  }).filter((candidate) => candidate.score > 0).sort((left, right) => right.score - left.score || left.item.field.localeCompare(right.item.field));
}

function selectField(request: string, catalog: readonly CatalogColumn[], kind: SemanticKind, preferredTable?: string) {
  return uniqueBest(fieldScores(request, catalog, kind, preferredTable), kind === "measure" ? 10 : 5)?.item ?? null;
}

function columnsForTable(catalog: readonly CatalogColumn[], table: string) {
  return catalog.filter((item) => item.column.table === table);
}

function sourceForRequest(request: string, catalog: readonly CatalogColumn[], metric?: CatalogColumn | null) {
  // An explicitly and uniquely grounded measure defines the observation
  // relation. This takes precedence over incidental table-token matches (for
  // example a measure token that is also another relation's name).
  if (metric) return metric.column.table!;
  const relations = relationScores(request, catalog);
  const observationRelations = relations.filter((item) => item.observationShape);
  const explicitObservation = uniqueBest(observationRelations.filter((item) => item.complete), 10);
  if (explicitObservation) return explicitObservation.table;
  const inferredObservation = uniqueBest(observationRelations, 10);
  if (inferredObservation) return inferredObservation.table;
  // Some legitimate single-table datasets contain only identifiers and
  // categories. An exact, unique relation mention is sufficient there; a
  // partial or tied relation mention still fails closed.
  return uniqueBest(relations.filter((item) => item.complete), 10)?.table ?? null;
}

function entityIdentifier(request: string, catalog: readonly CatalogColumn[], source: string) {
  const phrase = request.match(/\b(?:different|distinct|unique)\s+(.+?)\s+(?:appear|represented|occur|found)\b/i)?.[1]
    ?? request.match(/\bhow many\s+(.+?)\s+(?:have|has|had|with|recorded|generated|produced|made)\s+at least\b/i)?.[1]
    ?? request.match(/\b(?:which|return|show|list)\s+(.+?)\s+(?:ids?|identifiers?)\b/i)?.[1]
    ?? "";
  const populationTokens = new Set(tokens(phrase));
  if (populationTokens.size) {
    const candidates = columnsForTable(catalog, source).filter((item) => item.kind === "identifier").map((item) => ({
      item,
      score: item.fieldTokens.filter((token) => populationTokens.has(token)).length * 20,
    })).filter((candidate) => candidate.score > 0).sort((left, right) => right.score - left.score || left.item.field.localeCompare(right.item.field));
    const selected = uniqueBest(candidates, 20)?.item;
    if (selected) return selected;
    const remote = catalog.filter((item) => item.kind === "identifier").map((item) => ({
      item,
      score: item.fieldTokens.filter((token) => populationTokens.has(token)).length * 20,
    })).filter((candidate) => candidate.score > 0).sort((left, right) => right.score - left.score || left.item.field.localeCompare(right.item.field));
    const remoteField = uniqueBest(remote, 20)?.item;
    const sourceField = remoteField && catalog.find((item) => item.column.table === source && item.column.name === remoteField.column.name && item.kind === "identifier");
    if (sourceField) return sourceField;
  }
  const onSource = selectField(request, catalog, "identifier", source);
  if (onSource) return onSource;
  const elsewhere = selectField(request, catalog, "identifier");
  if (!elsewhere) return null;
  return catalog.find((item) => item.column.table === source && item.column.name === elsewhere.column.name && item.kind === "identifier") ?? null;
}

function primaryIdentifier(catalog: readonly CatalogColumn[], table: string) {
  const tableTokens = tokens(table);
  const tableRoot = tableTokens.at(-1);
  const identifiers = columnsForTable(catalog, table).filter((item) => item.kind === "identifier");
  const exact = identifiers.filter((item) => {
    const identityTokens = tokens(item.column.name).filter((token) => token !== "id");
    return identityTokens.length === tableTokens.length && identityTokens.every((token, index) => token === tableTokens[index]);
  });
  if (exact.length === 1) return exact[0];
  const canonical = identifiers.filter((item) => tableRoot && tokens(item.column.name).includes(tableRoot));
  return canonical.length === 1 ? canonical[0] : identifiers.length === 1 ? identifiers[0] : null;
}

function literal(value: string) { return `'${value.replaceAll("'", "''")}'`; }
function quote(value: string) { return `"${value.replaceAll('"', '""')}"`; }
function explicitValue(request: string, value: string) {
  const phrase = tokens(value);
  if (!phrase.length) return false;
  const requestTokens = tokens(request);
  return phrase.every((word) => requestTokens.includes(word));
}

async function categoricalValuesNamedByRequest(request: string, catalog: readonly CatalogColumn[], source: string, executeSql: AnalyticalGroundingExecutor) {
  const candidates = columnsForTable(catalog, source).filter((item) => textType.test(item.column.type));
  if (!candidates.length) return [];
  const requestLiteral = literal(request);
  const query = candidates.map(({ column, field }) => `SELECT ${literal(field)} AS ${quote("field")}, CAST(${quote(column.name)} AS VARCHAR) AS ${quote("value")} FROM ${quote(source)} WHERE ${quote(column.name)} IS NOT NULL AND LENGTH(CAST(${quote(column.name)} AS VARCHAR)) BETWEEN 1 AND 100 AND STRPOS(LOWER(${requestLiteral}), LOWER(CAST(${quote(column.name)} AS VARCHAR))) > 0 GROUP BY ${quote(column.name)}`).join("\nUNION ALL\n");
  const result = await executeSql(query);
  if (result.receipt.truncated) return [];
  const matches = result.rows.flatMap((row) => typeof row[0] === "string" && typeof row[1] === "string" && explicitValue(request, row[1]) ? [{ field: row[0], value: row[1] }] : []);
  const unique = new Map(matches.map((match) => [`${match.field}\0${match.value.toLocaleLowerCase()}`, match]));
  return [...unique.values()].sort((left, right) => right.value.length - left.value.length || left.field.localeCompare(right.field));
}

const numberWords: Readonly<Record<string, number>> = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
});

function boundedNumber(value: string | undefined) {
  if (!value) return null;
  const parsed = /^\d+$/.test(value) ? Number(value) : numberWords[value.toLocaleLowerCase()];
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 200 ? parsed : null;
}

function requestedBound(request: string, prefix: RegExp) {
  const match = request.match(new RegExp(`${prefix.source}\\s+(\\d{1,3}|${Object.keys(numberWords).join("|")})\\b`, "i"));
  return boundedNumber(match?.[1]);
}

function requestedRankBound(request: string) {
  return requestedBound(request, /\b(?:top|first|highest|largest|biggest|leading|best)/)
    ?? boundedNumber(request.match(new RegExp(`\\b(\\d{1,3}|${Object.keys(numberWords).join("|")})\\s+(?:highest|largest|biggest|leading|best)\\b`, "i"))?.[1]);
}

const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
function requestedMonth(request: string) {
  const match = request.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(20\d{2})\b/i);
  if (!match) return null;
  const key = match[1].toLocaleLowerCase();
  const index = months.findIndex((month) => month === key || month.startsWith(key.slice(0, 3)));
  if (index < 0) return null;
  const start = `${match[2]}-${String(index + 1).padStart(2, "0")}-01`;
  const end = new Date(Date.UTC(Number(match[2]), index + 1, 1)).toISOString().slice(0, 10);
  return { start, end };
}

function requestedMonths(request: string) {
  const matches = [...request.matchAll(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(20\d{2})\b/gi)];
  return matches.flatMap((match) => {
    const key = match[1].toLocaleLowerCase();
    const index = months.findIndex((month) => month === key || month.startsWith(key.slice(0, 3)));
    if (index < 0) return [];
    const start = `${match[2]}-${String(index + 1).padStart(2, "0")}-01`;
    const end = new Date(Date.UTC(Number(match[2]), index + 1, 1)).toISOString().slice(0, 10);
    return [{ start, end }];
  });
}

function generalPlan(input: Omit<GeneralSqlPlan, "action" | "windows" | "qualify" | "explanation"> & { explanation?: string }): GeneralSqlPlan {
  return { action: "query", windows: [], qualify: [], explanation: input.explanation ?? "Compile the fully grounded local analytical contract.", ...input };
}

function advancedPlan(operation: AdvancedAnalyticalPlan["operation"], input: Partial<AdvancedAnalyticalPlan>): AdvancedAnalyticalPlan {
  return {
    action: "query", operation, source: "", metric: "", secondaryMetric: "", entity: "", groupField: "",
    innerAggregate: "count", outerAggregate: "avg", distinct: false, dimensions: [], startField: "", endField: "",
    dateField: "", relatedField: "", filters: [], numeratorFilters: [], denominatorFilters: [], threshold: 0, decimals: 2,
    firstStart: "", firstEnd: "", secondStart: "", secondEnd: "",
    explanation: "Compile the fully grounded local analytical contract.", ...input,
  };
}

function grounded<T extends SchemaGroundedPhaseOnePlan["kind"]>(kind: T, plan: T extends "general" ? GeneralSqlPlan : AdvancedAnalyticalPlan, operation: string, fields: readonly string[], values: readonly { field: string; value: string }[]): SchemaGroundedPhaseOnePlan {
  return { kind, plan, grounding: { operation, source: plan.source, fields, categoricalValues: values, confidence: "deterministic" } } as SchemaGroundedPhaseOnePlan;
}

/**
 * Resolves the bounded Phase 1 analytical vocabulary from schema and approved
 * local values. It is domain-neutral: no benchmark table, column or value name
 * is present here. A plan is returned only when every required role is unique.
 */
export async function resolveSchemaGroundedPhaseOnePlan(request: string, columns: DatasetColumn[], executeSql: AnalyticalGroundingExecutor): Promise<SchemaGroundedPhaseOnePlan | null> {
  const catalog = buildAnalyticalSemanticCatalog(columns);
  if (!catalog.length) return null;
  const requestTokens = new Set(tokens(request));
  const namedTables = [...new Set(catalog.map((item) => item.column.table!))].filter((table) => phraseTokensPresent(tokens(table), requestTokens));
  const groupingLabel = tokens(request.match(/\b(?:for each|for every|by|per|inside each|inside every)\s+(?:the\s+)?([a-z][a-z0-9_-]*)(?:\s+name)?\b/i)?.[1] ?? "")[0];
  const groupingTables = groupingLabel ? namedTables.filter((table) => tokens(table).includes(groupingLabel)) : [];
  const requestedGroupCategory = groupingTables.length === 1 ? selectField(request, catalog, "category", groupingTables[0]) : selectField(request, catalog, "category");

  const preservesZeroActivityPopulation = /\b(?:every|all)\b/i.test(request) && /\b(?:even|including|include)\b.{0,100}\b(?:none|no activity|zero)\b/i.test(request);
  if (!preservesZeroActivityPopulation && /\b(?:never|without|(?:have|has|had)\s+no)\b/i.test(request)) {
    const candidates = namedTables.flatMap((entityTable) => {
      const entity = primaryIdentifier(catalog, entityTable);
      if (!entity) return [];
      return namedTables.filter((table) => table !== entityTable).flatMap((relatedTable) => {
        const related = primaryIdentifier(catalog, relatedTable);
        const shared = related && catalog.find((item) => item.column.table === relatedTable && item.column.name === entity.column.name && item.kind === "identifier");
        return related && shared ? [{ entityTable, entity, related }] : [];
      });
    });
    if (candidates.length === 1) {
      const match = candidates[0];
      const plan = advancedPlan("anti_join", { source: match.entityTable, entity: match.entity.field, relatedField: match.related.field });
      return grounded("advanced", plan, "missing-relationships", [match.entity.field, match.related.field], []);
    }
  }

  const weighted = request.match(/\boverall\s+(.+?)\s+per\s+(.+?)(?:,|\bweighted\b|\?|$)/i);
  if (weighted && /\bweighted\b/i.test(request)) {
    const numerator = selectField(weighted[1], catalog, "measure");
    const denominator = selectField(weighted[2], catalog, "measure");
    if (numerator && denominator && numerator.field !== denominator.field && numerator.column.table === denominator.column.table) {
      const plan = advancedPlan("ratio", { source: numerator.column.table!, metric: numerator.field, secondaryMetric: denominator.field });
      return grounded("advanced", plan, "weighted-ratio", [numerator.field, denominator.field], []);
    }
  }

  if (/\b(?:target|attainment)\b/i.test(request) && /\b(?:total|sum|actual)\b/i.test(request)) {
    const targetCandidates = catalog.filter((item) => item.kind === "measure" && item.fieldTokens.includes("target") && requestTokens.has("target"));
    const actualCatalog = catalog.filter((item) => item.kind === "measure" && !item.fieldTokens.includes("target"));
    const actual = selectField(request, actualCatalog, "measure");
    const pairs = targetCandidates.flatMap((target) => {
      const targetEntity = primaryIdentifier(catalog, target.column.table!);
      const eventKey = actual && targetEntity && catalog.find((item) => item.column.table === actual.column.table && item.column.name === targetEntity.column.name && item.kind === "identifier");
      return actual && targetEntity && eventKey ? [{ actual, target, targetEntity, eventKey }] : [];
    });
    if (pairs.length === 1) {
      const match = pairs[0];
      const plan = advancedPlan("target_attainment", { source: match.actual.column.table!, metric: match.actual.field, secondaryMetric: match.target.field, entity: match.targetEntity.field, groupField: match.eventKey.field });
      return grounded("advanced", plan, "target-attainment", [match.actual.field, match.target.field, match.targetEntity.field, match.eventKey.field], []);
    }
  }

  if (/\b(?:below|under)\b.{0,80}\btarget\b|\b(?:target\s+)?(?:variance|shortfall|gap)\b/i.test(request)
    && /\b(?:by how much|variance|shortfall|gap)\b/i.test(request)) {
    const targetCandidates = catalog.filter((item) => item.kind === "measure" && item.fieldTokens.includes("target") && requestTokens.has("target"));
    const actualCatalog = catalog.filter((item) => item.kind === "measure" && !item.fieldTokens.includes("target"));
    const actual = selectField(request, actualCatalog, "measure");
    const pairs = targetCandidates.flatMap((target) => {
      const targetEntity = primaryIdentifier(catalog, target.column.table!);
      const eventKey = actual && targetEntity && catalog.find((item) => item.column.table === actual.column.table && item.column.name === targetEntity.column.name && item.kind === "identifier");
      return actual && targetEntity && eventKey ? [{ actual, target, targetEntity, eventKey }] : [];
    });
    if (pairs.length === 1) {
      const match = pairs[0];
      const plan = advancedPlan("target_variance", { source: match.actual.column.table!, metric: match.actual.field, secondaryMetric: match.target.field, entity: match.targetEntity.field, groupField: match.eventKey.field });
      return grounded("advanced", plan, "target-variance", [match.actual.field, match.target.field, match.targetEntity.field, match.eventKey.field], []);
    }
    const plan = advancedPlan("target_variance", {
      action: "clarify",
      explanation: "Which approved actual measure should be compared with the target?",
    });
    return grounded("advanced", plan, "target-variance-clarification", [], []);
  }

  if (/\b(?:average|mean)\b.{0,100}\b(?:number|count)\s+of\b/i.test(request)
    && /\b(?:none|no activity|zero)\b/i.test(request)
    && /\bactive\b/i.test(request)) {
    const candidates = namedTables.flatMap((entityTable) => {
      const entity = primaryIdentifier(catalog, entityTable);
      const activeFields = columnsForTable(catalog, entityTable).filter((item) => item.kind === "boolean" && item.fieldTokens.some((token) => token === "active" && requestTokens.has(token)));
      if (!entity || activeFields.length !== 1) return [];
      return namedTables.filter((table) => table !== entityTable).flatMap((observationTable) => {
        const related = primaryIdentifier(catalog, observationTable);
        const eventKey = catalog.find((item) => item.column.table === observationTable && item.column.name === entity.column.name && item.kind === "identifier");
        return related && eventKey ? [{ entityTable, entity, active: activeFields[0], related, eventKey }] : [];
      });
    });
    if (candidates.length === 1) {
      const match = candidates[0];
      const plan = advancedPlan("complete_count_average", {
        source: match.entityTable,
        entity: match.entity.field,
        groupField: match.eventKey.field,
        relatedField: match.related.field,
        filters: [{ column: match.active.field, operator: "eq", value: "true" }],
      });
      return grounded("advanced", plan, "complete-count-average", [match.entity.field, match.eventKey.field, match.related.field, match.active.field], []);
    }
  }

  if (/\b(?:latest|newest|most recent)\b/i.test(request) && /\b(?:for each|for every|per)\b/i.test(request)) {
    const candidates = namedTables.flatMap((observationTable) => {
      const event = primaryIdentifier(catalog, observationTable);
      const dates = columnsForTable(catalog, observationTable).filter((item) => item.kind === "temporal");
      const dateOnly = dates.filter((item) => /^DATE$/i.test(item.column.type));
      const date = dateOnly.length === 1 ? dateOnly[0] : dates.length === 1 ? dates[0] : null;
      if (!event || !date) return [];
      return namedTables.filter((table) => table !== observationTable).flatMap((entityTable) => {
        const entity = primaryIdentifier(catalog, entityTable);
        const eventKey = entity && catalog.find((item) => item.column.table === observationTable && item.column.name === entity.column.name && item.kind === "identifier");
        return entity && eventKey ? [{ event, eventKey, date }] : [];
      });
    });
    if (candidates.length === 1) {
      const match = candidates[0];
      const plan = advancedPlan("latest_per_group", { source: match.event.column.table!, entity: match.event.field, groupField: match.eventKey.field, dateField: match.date.field });
      return grounded("advanced", plan, "latest-per-entity", [match.event.field, match.eventKey.field, match.date.field], []);
    }
  }

  if (/\b(?:for each|for every|by|per)\b/i.test(request) && /\b(?:how many|count|number)\b.{0,80}\b(?:different|distinct|unique)\b|\b(?:different|distinct|unique)\b.{0,80}\b(?:generated|activity|appear|count)\b/i.test(request)) {
    const group = requestedGroupCategory;
    const entityTables = namedTables.flatMap((table) => {
      const entity = primaryIdentifier(catalog, table);
      return entity && requestTokens.has(tokens(table).at(-1) ?? "") ? [{ table, entity }] : [];
    });
    const candidates = entityTables.flatMap(({ table, entity }) => catalog
      .filter((item) => item.kind === "identifier" && item.column.name === entity.column.name && item.column.table !== table)
      .filter((item) => {
        const fields = columnsForTable(catalog, item.column.table!);
        return fields.some((field) => field.kind === "measure") && fields.some((field) => field.kind === "temporal");
      })
      .map((eventKey) => ({ entity, eventKey })));
    if (group && candidates.length === 1) {
      const match = candidates[0];
      const plan = generalPlan({ source: match.eventKey.column.table!, dimensions: [group.field], filters: [], aggregates: [{ slot: "metric_1", aggregate: "count", field: match.eventKey.field, distinct: true }], having: [], orderBy: [{ field: group.field, direction: "asc" }], limit: 0 });
      return grounded("general", plan, "grouped-distinct-population", [group.field, match.eventKey.field], []);
    }
  }
  const metric = selectField(request, catalog, "measure");
  const source = sourceForRequest(request, catalog, metric);
  if (!source) return null;
  const sourceMetric = selectField(request, catalog, "measure", source) ?? (metric?.column.table === source ? metric : null);
  const category = selectField(request, catalog, "category", source);
  const sourceId = primaryIdentifier(catalog, source);
  const completeFilteredPopulation = /\b(?:every|all)\b/i.test(request) && /\b(?:even|including|include)\b.{0,100}\b(?:none|no activity|zero)\b/i.test(request);
  const valuesNeeded = /\b(?:how many|count|how much|total|sum|percent|percentage|rate)\b/i.test(request) || completeFilteredPopulation;
  const values = valuesNeeded ? await categoricalValuesNamedByRequest(request, catalog, source, executeSql) : [];
  const uniqueValue = values.length === 1 ? values[0] : null;
  const emptyFilters: GeneralSqlPlan["filters"] = [];
  const emptyHaving: GeneralSqlPlan["having"] = [];

  if (uniqueValue && /\b(?:percent|percentage|rate)\b/i.test(request) && /\b(?:all|overall)\b/i.test(request)) {
    const plan = advancedPlan("conditional_rate", { source, numeratorFilters: [{ column: uniqueValue.field, operator: "eq", value: uniqueValue.value }] });
    return grounded("advanced", plan, "conditional-rate", [uniqueValue.field], values);
  }

  if (/\b(?:90th percentile|percentile\s+90|p90)\b/i.test(request) && sourceMetric) {
    const plan = generalPlan({ source, dimensions: [], filters: emptyFilters, aggregates: [{ slot: "metric_1", aggregate: "quantile_90", field: sourceMetric.field, distinct: false }], having: emptyHaving, orderBy: [], limit: 0 });
    return grounded("general", plan, "percentile", [sourceMetric.field], values);
  }

  if (/\b(?:average|mean)\s+of\s+each\b.{0,100}\btotal\b/i.test(request) && sourceMetric) {
    const entityTables = namedTables.flatMap((table) => {
      const entity = primaryIdentifier(catalog, table);
      const eventKey = entity && catalog.find((item) => item.column.table === source && item.column.name === entity.column.name && item.kind === "identifier");
      return entity && eventKey && table !== source ? [{ entity, eventKey }] : [];
    });
    if (entityTables.length === 1) {
      const match = entityTables[0];
      const plan = advancedPlan("per_entity_average", { source, metric: sourceMetric.field, entity: match.eventKey.field });
      return grounded("advanced", plan, "average-entity-total", [sourceMetric.field, match.eventKey.field], values);
    }
  }

  if (/\bmonthly\b.{0,80}\b(?:total|sum)\b.{0,120}\b(?:change|difference)\b.{0,80}\bprevious month\b/i.test(request) && sourceMetric) {
    const temporal = columnsForTable(catalog, source).filter((item) => item.kind === "temporal");
    const dateOnly = temporal.filter((item) => /^DATE$/i.test(item.column.type));
    const date = selectField(request, catalog, "temporal", source) ?? (dateOnly.length === 1 ? dateOnly[0] : temporal.length === 1 ? temporal[0] : null);
    if (date) {
      const plan = advancedPlan("month_over_month", { source, metric: sourceMetric.field, dateField: date.field });
      return grounded("advanced", plan, "month-over-month", [sourceMetric.field, date.field], values);
    }
  }

  const partitionRank = request.match(/\binside\s+(?:each|every)\s+([a-z][a-z0-9_-]*)\b.{0,120}\bwhich\s+(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten)\b/i);
  if (partitionRank && sourceMetric && /\bhighest\s+total\b/i.test(request)) {
    const limit = boundedNumber(partitionRank[2]);
    const group = requestedGroupCategory;
    const entityTables = namedTables.flatMap((table) => {
      const entity = primaryIdentifier(catalog, table);
      const eventKey = entity && catalog.find((item) => item.column.table === source && item.column.name === entity.column.name && item.kind === "identifier");
      return entity && eventKey && table !== source && table !== group?.column.table ? [{ eventKey }] : [];
    });
    if (limit && group && entityTables.length === 1) {
      const entity = entityTables[0].eventKey;
      const plan: GeneralSqlPlan = { action: "query", source, dimensions: [group.field, entity.field], filters: [], aggregates: [{ slot: "metric_1", aggregate: "sum", field: sourceMetric.field, distinct: false }], windows: [{ slot: "window_1", function: "row_number", input: "", partitionBy: [group.field], orderBy: [{ field: "metric_1", direction: "desc" }, { field: entity.field, direction: "asc" }], frameRows: 0 }], having: [], qualify: [{ window: "window_1", operator: "lte", value: limit }], orderBy: [{ field: group.field, direction: "asc" }, { field: "window_1", direction: "asc" }], limit: 0, explanation: "Rank grouped totals inside each explicitly grounded partition with a deterministic identifier tie-break." };
      return grounded("general", plan, "partitioned-ranking", [group.field, entity.field, sourceMetric.field], values);
    }
  }

  if (/\b(?:average|mean)\b.{0,80}\b(?:hours?|minutes?|days?)\b.{0,100}\b(?:start|begin)\b.{0,80}\b(?:finish|end)\b/i.test(request)) {
    const sourceTemporal = columnsForTable(catalog, source).filter((item) => item.kind === "temporal");
    const start = sourceTemporal.filter((item) => /(?:^|_)(?:start|started|begin|began)(?:_|$)/i.test(item.column.name));
    const end = sourceTemporal.filter((item) => /(?:^|_)(?:end|ended|finish|finished)(?:_|$)/i.test(item.column.name));
    const pairs = start.flatMap((startField) => end.filter((endField) => endField.column.type.toLocaleUpperCase() === startField.column.type.toLocaleUpperCase()).map((endField) => ({ startField, endField })));
    const pair = pairs.length === 1 ? pairs[0] : start.length === 1 && end.length === 1 ? { startField: start[0], endField: end[0] } : null;
    if (pair && pair.startField.field !== pair.endField.field) {
      const plan = advancedPlan("duration_average", { source, startField: pair.startField.field, endField: pair.endField.field });
      return grounded("advanced", plan, "duration-average", [pair.startField.field, pair.endField.field], values);
    }
  }

  const periods = requestedMonths(request);
  if (periods.length === 2 && sourceMetric && /\b(?:change|growth|increase|decrease)\b.{0,80}\b(?:percent|percentage)\b|\b(?:percent|percentage)\b.{0,80}\b(?:change|growth|increase|decrease)\b/i.test(request)) {
    const temporal = columnsForTable(catalog, source).filter((item) => item.kind === "temporal");
    const dateOnly = temporal.filter((item) => /^DATE$/i.test(item.column.type));
    const date = selectField(request, catalog, "temporal", source) ?? (dateOnly.length === 1 ? dateOnly[0] : temporal.length === 1 ? temporal[0] : null);
    if (date) {
      const plan = advancedPlan("period_growth", { source, metric: sourceMetric.field, dateField: date.field, firstStart: periods[0].start, firstEnd: periods[0].end, secondStart: periods[1].start, secondEnd: periods[1].end });
      return grounded("advanced", plan, "period-growth", [sourceMetric.field, date.field], values);
    }
  }

  const bothAggregates = /\b(?:both\s+)?(?:total|sum)\b.{0,40}\b(?:and|plus|with)\b.{0,40}\b(?:average|mean)\b|\b(?:both\s+)?(?:average|mean)\b.{0,40}\b(?:and|plus|with)\b.{0,40}\b(?:total|sum)\b/i.test(request);
  if (bothAggregates && sourceMetric) {
    const group = selectField(request, catalog, "category");
    if (!group || group.column.table === source && group.field === category?.field && !/\b(?:by|per|each|every)\b/i.test(request)) return null;
    const plan = generalPlan({ source, dimensions: [group.field], filters: emptyFilters, aggregates: [
      { slot: "metric_1", aggregate: "sum", field: sourceMetric.field, distinct: false },
      { slot: "metric_2", aggregate: "avg", field: sourceMetric.field, distinct: false },
    ], having: emptyHaving, orderBy: [{ field: group.field, direction: "asc" }], limit: 0 });
    return grounded("general", plan, "multiple-aggregates", [group.field, sourceMetric.field], values);
  }

  if (/\b(?:total|sum)\b/i.test(request) && sourceMetric && /\b(?:for each|for every|by|per)\b/i.test(request) && !/\b(?:average|mean)\b/i.test(request)) {
    const group = requestedGroupCategory;
    if (group) {
      const plan = generalPlan({ source, dimensions: [group.field], filters: emptyFilters, aggregates: [{ slot: "metric_1", aggregate: "sum", field: sourceMetric.field, distinct: false }], having: emptyHaving, orderBy: [{ field: group.field, direction: "asc" }], limit: 0 });
      return grounded("general", plan, "grouped-total", [group.field, sourceMetric.field], values);
    }
  }

  const rangeRequested = /\b(?:lowest|minimum|min)\b.{0,80}\b(?:highest|maximum|max)\b|\b(?:highest|maximum|max)\b.{0,80}\b(?:lowest|minimum|min)\b/i.test(request);
  if (rangeRequested && sourceMetric && category && /\b(?:each|every|by|per|break(?:down)?|state|status|category)\b/i.test(request)) {
    const plan = generalPlan({ source, dimensions: [category.field], filters: emptyFilters, aggregates: [
      { slot: "metric_1", aggregate: "min", field: sourceMetric.field, distinct: false },
      { slot: "metric_2", aggregate: "max", field: sourceMetric.field, distinct: false },
    ], having: emptyHaving, orderBy: [{ field: category.field, direction: "asc" }], limit: 0 });
    return grounded("general", plan, "range-by-category", [category.field, sourceMetric.field], values);
  }

  const distinctRequested = /\b(?:how many|number of|count)\b.{0,60}\b(?:different|distinct|unique)\b|\b(?:different|distinct|unique)\b.{0,60}\b(?:how many|number|count|appear)\b/i.test(request);
  if (distinctRequested) {
    const entity = entityIdentifier(request, catalog, source);
    if (!entity) return null;
    const plan = advancedPlan("distinct_count", { source, entity: entity.field });
    return grounded("advanced", plan, "distinct-count", [entity.field], values);
  }

  const threshold = requestedBound(request, /\bat\s+least/);
  if (threshold && /\bhow many\b/i.test(request)) {
    const entity = entityIdentifier(request, catalog, source);
    if (!entity) return null;
    const filters = uniqueValue ? [{ column: uniqueValue.field, operator: "eq" as const, value: uniqueValue.value }] : [];
    const plan = advancedPlan("threshold_count", { source, entity: entity.field, threshold, filters });
    return grounded("advanced", plan, "threshold-count", [entity.field, ...filters.map((filter) => filter.column)], values);
  }

  const havingMatch = request.match(/\b(?:more than|greater than|above|over|exceeds?|at least|no less than|less than|below|under|at most|no more than)\s+(-?\d+(?:\.\d+)?)\b/i);
  if (havingMatch && /\b(?:total|sum)\b/i.test(request) && sourceMetric) {
    const entity = entityIdentifier(request, catalog, source);
    if (!entity) return null;
    const phrase = havingMatch[0].toLocaleLowerCase();
    const operator = /^(?:at least|no less than)/.test(phrase) ? "gte" as const : /^(?:at most|no more than)/.test(phrase) ? "lte" as const : /more|greater|above|over|exceed/.test(phrase) ? "gt" as const : "lt" as const;
    const plan = generalPlan({ source, dimensions: [entity.field], filters: emptyFilters, aggregates: [{ slot: "metric_1", aggregate: "sum", field: sourceMetric.field, distinct: false }], having: [{ metric: "metric_1", operator, value: Number(havingMatch[1]) }], orderBy: [{ field: "metric_1", direction: "desc" }, { field: entity.field, direction: "asc" }], limit: 0 });
    return grounded("general", plan, "grouped-having", [entity.field, sourceMetric.field], values);
  }

  const top = requestedRankBound(request);
  if (top && sourceMetric && sourceId && /\b(?:top|highest|largest|biggest|leading|best)\b/i.test(request)) {
    const plan = generalPlan({ source, dimensions: [sourceId.field, sourceMetric.field], filters: emptyFilters, aggregates: [], having: emptyHaving, orderBy: [{ field: sourceMetric.field, direction: "desc" }, { field: sourceId.field, direction: "asc" }], limit: top });
    return grounded("general", plan, "ordered-top-records", [sourceId.field, sourceMetric.field], values);
  }

  const month = requestedMonth(request);
  if (month && /\b(?:how many|count|number)\b/i.test(request)) {
    const dateColumns = columnsForTable(catalog, source).filter((item) => item.kind === "temporal");
    const namedDate = selectField(request, catalog, "temporal", source);
    const dateOnly = dateColumns.filter((item) => /^DATE$/i.test(item.column.type));
    const date = namedDate ?? (dateOnly.length === 1 ? dateOnly[0] : dateColumns.length === 1 ? dateColumns[0] : null);
    if (!date) return null;
    const plan = generalPlan({ source, dimensions: [], filters: [{ column: date.field, operator: "gte", value: month.start }, { column: date.field, operator: "lt", value: month.end }], aggregates: [{ slot: "metric_1", aggregate: "count", field: "*", distinct: false }], having: emptyHaving, orderBy: [], limit: 0 });
    return grounded("general", plan, "date-filtered-count", [date.field], values);
  }

  if (/\b(?:middle|median)\b/i.test(request) && sourceMetric) {
    const plan = generalPlan({ source, dimensions: [], filters: emptyFilters, aggregates: [{ slot: "metric_1", aggregate: "median", field: sourceMetric.field, distinct: false }], having: emptyHaving, orderBy: [], limit: 0 });
    return grounded("general", plan, "median", [sourceMetric.field], values);
  }

  if (/\b(?:break(?:down)?|split|group)\b.{0,80}\b(?:state|status|category)\b|\b(?:by|per)\s+(?:their\s+)?(?:state|status|category)\b/i.test(request) && category && /\b(?:count|how many|show)\b/i.test(request)) {
    const plan = generalPlan({ source, dimensions: [category.field], filters: emptyFilters, aggregates: [{ slot: "metric_1", aggregate: "count", field: "*", distinct: false }], having: emptyHaving, orderBy: [{ field: category.field, direction: "asc" }], limit: 0 });
    return grounded("general", plan, "category-breakdown", [category.field], values);
  }

  if (completeFilteredPopulation && uniqueValue && sourceMetric) {
    const entityCandidates = namedTables.flatMap((table) => {
      const entity = primaryIdentifier(catalog, table);
      const eventKey = entity && catalog.find((item) => item.column.table === source && item.column.name === entity.column.name && item.kind === "identifier");
      return entity && eventKey && table !== source ? [{ entity, eventKey }] : [];
    });
    if (entityCandidates.length === 1) {
      const match = entityCandidates[0];
      const plan = advancedPlan("complete_filtered_sum", { source, metric: sourceMetric.field, entity: match.entity.field, groupField: match.eventKey.field, numeratorFilters: [{ column: uniqueValue.field, operator: "eq", value: uniqueValue.value }] });
      return grounded("advanced", plan, "complete-filtered-sum", [sourceMetric.field, match.entity.field, match.eventKey.field, uniqueValue.field], values);
    }
  }

  if (uniqueValue && /\b(?:how much|total|sum)\b/i.test(request) && sourceMetric) {
    const plan = generalPlan({ source, dimensions: [], filters: [{ column: uniqueValue.field, operator: "eq", value: uniqueValue.value }], aggregates: [{ slot: "metric_1", aggregate: "sum", field: sourceMetric.field, distinct: false }], having: emptyHaving, orderBy: [], limit: 0 });
    return grounded("general", plan, "filtered-total", [sourceMetric.field, uniqueValue.field], values);
  }

  if (uniqueValue && /\b(?:how many|count|number)\b/i.test(request)) {
    const plan = generalPlan({ source, dimensions: [], filters: [{ column: uniqueValue.field, operator: "eq", value: uniqueValue.value }], aggregates: [{ slot: "metric_1", aggregate: "count", field: "*", distinct: false }], having: emptyHaving, orderBy: [], limit: 0 });
    return grounded("general", plan, "categorical-count", [uniqueValue.field], values);
  }

  const averageOfObservationCounts = /\b(?:average|mean)\b.{0,100}\b(?:number|count)\s+of\b|\bcounting\b.{0,100}\b(?:none|no activity|zero)\b/i.test(request);
  if (/\b(?:average|mean)\b/i.test(request) && sourceMetric && !averageOfObservationCounts && !/\b(?:per|each|duration|elapsed|weighted|rolling|moving)\b/i.test(request)) {
    const plan = generalPlan({ source, dimensions: [], filters: emptyFilters, aggregates: [{ slot: "metric_1", aggregate: "avg", field: sourceMetric.field, distinct: false }], having: emptyHaving, orderBy: [], limit: 0 });
    return grounded("general", plan, "average", [sourceMetric.field], values);
  }

  if (/\b(?:how many|count|number of)\b/i.test(request)
    && /\b(?:altogether|overall|in total|do (?:we|you) have)\b/i.test(request)
    && !/\b(?:different|distinct|unique|at least|state|status|category|during|in (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))\b/i.test(request)) {
    const plan = generalPlan({ source, dimensions: [], filters: emptyFilters, aggregates: [{ slot: "metric_1", aggregate: "count", field: "*", distinct: false }], having: emptyHaving, orderBy: [], limit: 0 });
    return grounded("general", plan, "row-count", [], values);
  }

  if (/\b(?:total|sum)\b/i.test(request) && sourceMetric
    && !/\b(?:average|mean|more than|greater than|above|over|at least|less than|below|under|at most|by|per|for each)\b/i.test(request)) {
    const plan = generalPlan({ source, dimensions: [], filters: emptyFilters, aggregates: [{ slot: "metric_1", aggregate: "sum", field: sourceMetric.field, distinct: false }], having: emptyHaving, orderBy: [], limit: 0 });
    return grounded("general", plan, "total", [sourceMetric.field], values);
  }

  return null;
}
