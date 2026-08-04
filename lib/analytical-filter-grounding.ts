import { compileAdvancedAnalyticalPlan, normalizeAdvancedAnalyticalPlan, parseAdvancedAnalyticalPlan, recoverAdvancedAnalyticalPlan, type AdvancedAnalyticalPlan, type Filter } from "./advanced-analytical-plan.ts";
import { executeReadOnlySql, type DatasetColumn } from "./sql-runtime.ts";

export type FilterGroundingDecision = {
  value: string;
  action: "kept" | "added" | "replaced" | "clarified";
  reason: string;
};

function quote(name: string) { return `"${name.replaceAll('"', '""')}"`; }
function literal(value: string) { return `'${value.replaceAll("'", "''")}'`; }
function explicitValue(request: string, value: string) {
  if (!value.trim() || /[{}[\]<>]|\$[a-z_]/i.test(value)) return false;
  return request.toLocaleLowerCase().includes(value.trim().toLocaleLowerCase());
}

function categoricalColumns(columns: DatasetColumn[]) {
  return columns.filter((column) => column.table && /CHAR|TEXT|STRING|ENUM/i.test(column.type));
}

async function matchingFields(value: string, columns: DatasetColumn[], approvedDatasetPath: string) {
  const candidates = categoricalColumns(columns);
  if (!candidates.length) return new Set<string>();
  const query = candidates.map((column) => `SELECT ${literal(`${column.table}.${column.name}`)} AS ${quote("field")} WHERE EXISTS (SELECT 1 FROM ${quote(column.table!)} WHERE LOWER(CAST(${quote(column.name)} AS VARCHAR)) = LOWER(${literal(value)}))`).join("\nUNION ALL\n");
  const result = await executeReadOnlySql({ approvedDatasetPath, query });
  return new Set(result.rows.flatMap((row) => typeof row[0] === "string" ? [row[0]] : []));
}

function words(value: string) {
  return value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function valueAppearsInRequest(request: string, value: string) {
  const phrase = words(value);
  if (!phrase.length) return false;
  return ` ${words(request).join(" ")} `.includes(` ${phrase.join(" ")} `);
}

async function categoricalValuesNamedByRequest(request: string, columns: DatasetColumn[], approvedDatasetPath: string) {
  const candidates = categoricalColumns(columns);
  if (!candidates.length) return [] as Array<{ field: string; value: string }>;
  const requestLiteral = literal(request);
  const query = candidates.map((column) => `SELECT DISTINCT ${literal(`${column.table}.${column.name}`)} AS ${quote("field")}, CAST(${quote(column.name)} AS VARCHAR) AS ${quote("value")} FROM ${quote(column.table!)} WHERE ${quote(column.name)} IS NOT NULL AND LENGTH(CAST(${quote(column.name)} AS VARCHAR)) BETWEEN 2 AND 100 AND STRPOS(LOWER(${requestLiteral}), LOWER(CAST(${quote(column.name)} AS VARCHAR))) > 0`).join("\nUNION ALL\n");
  const result = await executeReadOnlySql({ approvedDatasetPath, query });
  if (result.receipt.truncated) return [];
  return result.rows.flatMap((row) => typeof row[0] === "string" && typeof row[1] === "string" && valueAppearsInRequest(request, row[1]) ? [{ field: row[0], value: row[1] }] : []);
}

/**
 * Grounds model-selected categorical filter columns against the approved local
 * dataset. It never exposes rows or values to another provider: trusted code
 * checks only whether the explicit user literal exists in candidate text
 * columns, then repairs a unique mismatch or asks when several columns match.
 */
export async function groundAdvancedAnalyticalFilters(plan: AdvancedAnalyticalPlan, request: string, columns: DatasetColumn[], approvedDatasetPath: string) {
  const decisions: FilterGroundingDecision[] = [];
  if (plan.action !== "query") return { plan, decisions };
  const groups: Array<keyof Pick<AdvancedAnalyticalPlan, "filters" | "numeratorFilters" | "denominatorFilters">> = ["filters", "numeratorFilters", "denominatorFilters"];
  const cache = new Map<string, Set<string>>();
  const grounded = { ...plan, filters: plan.filters.map((item) => ({ ...item })), numeratorFilters: plan.numeratorFilters.map((item) => ({ ...item })), denominatorFilters: plan.denominatorFilters.map((item) => ({ ...item })) };
  for (const group of groups) for (const filter of grounded[group] as Filter[]) {
    if (filter.operator !== "eq" || !explicitValue(request, filter.value)) continue;
    const column = columns.find((candidate) => `${candidate.table}.${candidate.name}` === filter.column);
    if (!column || !/CHAR|TEXT|STRING|ENUM/i.test(column.type)) continue;
    let matches = cache.get(filter.value.toLocaleLowerCase());
    if (!matches) {
      matches = await matchingFields(filter.value, columns, approvedDatasetPath);
      cache.set(filter.value.toLocaleLowerCase(), matches);
    }
    if (matches.has(filter.column)) {
      decisions.push({ value: filter.value, action: "kept", reason: "The explicit categorical value exists in the selected approved field." });
      continue;
    }
    if (matches.size === 1) {
      const replacement = [...matches][0];
      decisions.push({ value: filter.value, action: "replaced", reason: "The explicit categorical value exists in exactly one approved field." });
      filter.column = replacement;
      continue;
    }
    if (matches.size > 1) {
      decisions.push({ value: filter.value, action: "clarified", reason: "The explicit categorical value appears in multiple approved fields." });
      return { plan: { ...grounded, action: "clarify" as const, explanation: `The value “${filter.value}” appears in multiple fields. Which field should define the filter?` }, decisions };
    }
    decisions.push({ value: filter.value, action: "kept", reason: "The explicit value was absent, so the schema-bound filter was retained to produce an honest zero-match result." });
  }
  const existingValues = new Set(groups.flatMap((group) => (grounded[group] as Filter[]).map((filter) => filter.value.toLocaleLowerCase())));
  const discovered = await categoricalValuesNamedByRequest(request, columns, approvedDatasetPath);
  const longest = discovered.filter((candidate) => !discovered.some((other) => other.value.length > candidate.value.length && valueAppearsInRequest(other.value, candidate.value)));
  const byValue = new Map<string, Array<{ field: string; value: string }>>();
  for (const candidate of longest) byValue.set(candidate.value.toLocaleLowerCase(), [...(byValue.get(candidate.value.toLocaleLowerCase()) ?? []), candidate]);
  for (const matches of [...byValue.values()].slice(0, 4)) {
    if (existingValues.has(matches[0].value.toLocaleLowerCase())) continue;
    const fields = [...new Set(matches.map((match) => match.field))];
    if (fields.length > 1) {
      decisions.push({ value: matches[0].value, action: "clarified", reason: "An explicit categorical value appears in multiple approved fields." });
      return { plan: { ...grounded, action: "clarify" as const, explanation: `The value “${matches[0].value}” appears in multiple fields. Which field should define the filter?` }, decisions };
    }
    grounded.filters.push({ column: fields[0], operator: "eq", value: matches[0].value });
    decisions.push({ value: matches[0].value, action: "added", reason: "The request names a value found in exactly one approved categorical field." });
  }
  return { plan: grounded, decisions };
}

export async function compileGroundedAdvancedAnalyticalPlan(rawPlan: string, request: string, columns: DatasetColumn[], approvedDatasetPath: string) {
  let parsed: AdvancedAnalyticalPlan;
  try { parsed = parseAdvancedAnalyticalPlan(rawPlan); }
  catch (error) {
    const recovered = recoverAdvancedAnalyticalPlan(request, columns);
    if (!recovered) throw error;
    parsed = recovered;
  }
  const normalized = normalizeAdvancedAnalyticalPlan(parsed, request, columns);
  const grounded = await groundAdvancedAnalyticalFilters(normalized, request, columns, approvedDatasetPath);
  return { proposal: compileAdvancedAnalyticalPlan(grounded.plan, columns), plan: grounded.plan, grounding: grounded.decisions };
}

export async function compileResolvedAdvancedAnalyticalPlan(request: string, columns: DatasetColumn[], approvedDatasetPath: string) {
  const recovered = recoverAdvancedAnalyticalPlan(request, columns);
  if (!recovered) return null;
  const normalized = normalizeAdvancedAnalyticalPlan(recovered, request, columns);
  const grounded = await groundAdvancedAnalyticalFilters(normalized, request, columns, approvedDatasetPath);
  return { proposal: compileAdvancedAnalyticalPlan(grounded.plan, columns), plan: grounded.plan, grounding: grounded.decisions };
}
