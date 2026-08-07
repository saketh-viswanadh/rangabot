import type { AdvancedAnalyticalPlan } from "./advanced-analytical-plan.ts";
import type { AnalyticalPlan } from "./analytical-plan.ts";
import type { SqlExecutionResult } from "./sql-runtime.ts";

export const ANALYTICAL_NARRATION_CONTRACT_VERSION = "1.0.0" as const;
const maximumRenderedRows = 20;
const maximumRenderedColumns = 12;
const maximumRenderedFilters = 20;
const maximumCellCharacters = 300;

export type ResolvedAnalyticalPlan =
  | { kind: "basic"; plan: AnalyticalPlan }
  | { kind: "advanced"; plan: AdvancedAnalyticalPlan };

export type AnalyticalNarrationMode = "empty" | "list" | "scalar" | "table";
export type AnalyticalNarrationUnit = "hours" | "percent" | null;

export type AnalyticalNarrationFact = {
  id: string;
  kind: "cell" | "completeness" | "row-count" | "column-count";
  label: string;
  value: string;
  unit: AnalyticalNarrationUnit;
  cell?: { row: number; column: number };
};

export type VerifiedAnalyticalNarration = {
  contractVersion: typeof ANALYTICAL_NARRATION_CONTRACT_VERSION;
  mode: AnalyticalNarrationMode;
  label: string;
  facts: AnalyticalNarrationFact[];
  claims: string[];
  complete: boolean;
  displayedRows: number;
  displayedColumns: number;
  answer: string;
};

export type VerifiedAnalyticalNarrationAudit = {
  valid: boolean;
  failures: Array<"canonical-mismatch" | "cell-mismatch" | "duplicate-fact" | "invalid-bound" | "receipt-mismatch" | "shape-mismatch" | "unsupported-number">;
};

type OutputColumn = { label: string; unit: AnalyticalNarrationUnit; expectedName: string; allowEngineDisambiguation?: boolean };
type ExpectedOutput = { grain: "list" | "scalar" | "table"; columns: OutputColumn[] };
type Filter = { column: string; operator: string; value: string };

function words(value: string) {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function leaf(value: string) {
  return value.split(".").at(-1) ?? value;
}

function tableName(value: string) {
  return words(value.split(".")[0] ?? value);
}

function fieldName(value: string) {
  const name = leaf(value);
  return name.endsWith("_id") ? `${words(name.slice(0, -3))} ID` : words(name);
}

function qualifiedFieldName(value: string) {
  const table = value.includes(".") ? tableName(value) : "";
  return [table, fieldName(value)].filter(Boolean).join(" ");
}

function capitalized(value: string) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function rawCellText(value: unknown): string {
  if (value === null) return "null";
  if (typeof value !== "object") return String(value);
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

function shorten(value: string) {
  const characters = [...value];
  if (characters.length <= maximumCellCharacters) return { value, shortened: false };
  return { value: `${characters.slice(0, maximumCellCharacters - 1).join("")}…`, shortened: true };
}

function scrub(value: string) {
  return value
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escaped(value: string) {
  const result = shorten(scrub(value));
  const safe = result.value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/\b([a-z][a-z0-9+.-]{1,20}):(?=\/\/)/giu, "$1\\:")
    // Break GFM email autolinks without displaying a replacement character.
    .replaceAll("@", "@\u2060")
    .replace(/[\\`*_{}\[\]()!]/g, "\\$&")
    .replaceAll("|", "\\|");
  return { text: safe, shortened: result.shortened };
}

function safeInline(value: string) {
  return escaped(value).text;
}

function safeTableCell(value: string) {
  return escaped(value).text;
}

function filterPhrase(filter: Filter) {
  const field = escaped(capitalized(qualifiedFieldName(filter.column)));
  const value = escaped(filter.value);
  const phrase = filter.operator === "is_null" ? `${field.text} is missing`
    : filter.operator === "is_not_null" ? `${field.text} has a value`
      : filter.operator === "eq" ? /^(?:true|false)$/i.test(filter.value) ? `${field.text} is ${value.text.toLowerCase()}` : `${field.text} equals ${value.text}`
        : filter.operator === "neq" ? `${field.text} does not equal ${value.text}`
          : filter.operator === "lt" ? `${field.text} is less than ${value.text}`
            : filter.operator === "lte" ? `${field.text} is at most ${value.text}`
              : filter.operator === "gt" ? `${field.text} is greater than ${value.text}`
                : filter.operator === "gte" ? `${field.text} is at least ${value.text}`
                  : `${field.text} uses ${safeInline(filter.operator)} ${value.text}`;
  return { text: phrase, shortened: field.shortened || value.shortened };
}

function renderedFilters(filters: Filter[]) {
  const visible = filters.slice(0, maximumRenderedFilters).map(filterPhrase);
  return {
    text: visible.length ? visible.map((item) => item.text).join("; ") : "all rows",
    omitted: filters.length > visible.length,
    shortened: visible.some((item) => item.shortened),
  };
}

function scopeFor(resolved: ResolvedAnalyticalPlan) {
  const sections: Array<{ label: string; filters: Filter[]; emptyText: string }> = [];
  if (resolved.kind === "basic") {
    if (resolved.plan.filters.length) sections.push({ label: "Scope", filters: resolved.plan.filters, emptyText: "all rows" });
  } else if (resolved.plan.operation === "conditional_rate") {
    if (resolved.plan.filters.length) sections.push({ label: "Base scope", filters: resolved.plan.filters, emptyText: "all source rows" });
    sections.push({ label: "Denominator within the base scope", filters: resolved.plan.denominatorFilters, emptyText: "all base-scope rows" });
    sections.push({ label: "Numerator within the denominator", filters: resolved.plan.numeratorFilters, emptyText: "no additional condition" });
  } else if (resolved.plan.filters.length) {
    sections.push({ label: "Scope", filters: resolved.plan.filters, emptyText: "all rows" });
  }
  let omitted = false;
  let shortened = false;
  const lines = sections.map((section) => {
    const rendered = renderedFilters(section.filters);
    omitted ||= rendered.omitted;
    shortened ||= rendered.shortened;
    const content = section.filters.length ? rendered.text : section.emptyText;
    return `- **${safeInline(section.label)}:** ${content}${rendered.omitted ? "; additional verified filters are omitted from display and remain visible in the calculation query" : ""}`;
  });
  return {
    text: lines.length ? `**Verified scope**\n${lines.join("\n")}` : "",
    claims: lines.map((line) => line.replace(/^- /, "")),
    omitted,
    shortened,
  };
}

function aggregateLabel(aggregate: string, metric: string, source: string) {
  if (aggregate === "count") return metric === "*" ? `Count of rows from ${tableName(source)}` : `Count of ${fieldName(metric)} values`;
  const field = fieldName(metric);
  if (aggregate === "sum") return `Total ${field}`;
  if (aggregate === "avg") return `Average ${field}`;
  if (aggregate === "min") return `Minimum ${field}`;
  if (aggregate === "max") return `Maximum ${field}`;
  return "Verified result";
}

function uniqueDimensionLabels(dimensions: string[]) {
  const leaves = dimensions.map(fieldName);
  return dimensions.map((dimension, index) => leaves.filter((label) => label === leaves[index]).length > 1
    ? qualifiedFieldName(dimension)
    : leaves[index]);
}

function basicLabel(plan: AnalyticalPlan) {
  const base = aggregateLabel(plan.aggregate, plan.metric, plan.source);
  const dimensions = uniqueDimensionLabels(plan.dimensions);
  return capitalized(`${base}${dimensions.length ? ` by ${dimensions.join(" and ")}` : ""}`);
}

function advancedLabel(plan: AdvancedAnalyticalPlan) {
  const metric = fieldName(plan.metric);
  const entity = fieldName(plan.entity);
  const group = fieldName(plan.groupField);
  const source = tableName(plan.source);
  if (plan.operation === "ratio") {
    const denominator = plan.secondaryMetric === "*" ? `row count from ${source}` : `total ${fieldName(plan.secondaryMetric)}`;
    return capitalized(`Ratio of total ${metric} to ${denominator}`);
  }
  if (plan.operation === "conditional_rate") return capitalized(`Percentage of ${source} meeting the verified numerator condition`);
  if (plan.operation === "distinct_count") return capitalized(`Distinct count of ${entity}`);
  if (plan.operation === "duration_average") return capitalized(`Average duration from ${fieldName(plan.startField)} to ${fieldName(plan.endField)}`);
  if (plan.operation === "threshold_count") return capitalized(`Count of ${entity} values with at least ${plan.threshold} rows from ${source}`);
  if (plan.operation === "period_growth") return capitalized(`Growth in ${metric} from [${plan.firstStart}, ${plan.firstEnd}) to [${plan.secondStart}, ${plan.secondEnd})`);
  if (plan.operation === "per_entity_average") return capitalized(`Average total ${metric} per ${entity}`);
  if (plan.operation === "aggregate_over_groups") {
    const innerNames: Record<string, string> = { count: "count of", avg: "average", sum: "total", min: "minimum", max: "maximum" };
    const outerNames: Record<string, string> = { avg: "Average", sum: "Total", min: "Minimum", max: "Maximum" };
    const measured = plan.metric === "*" ? `rows from ${source}` : fieldName(plan.metric);
    const distinct = plan.distinct ? "distinct " : "";
    return capitalized(`${outerNames[plan.outerAggregate] ?? plan.outerAggregate} ${distinct}${innerNames[plan.innerAggregate] ?? plan.innerAggregate} ${measured} per ${group}`);
  }
  return capitalized(`${entity} values without a matching row in ${tableName(plan.relatedField)}`);
}

export function analyticalNarrationLabel(resolved: ResolvedAnalyticalPlan) {
  return resolved.kind === "advanced" ? advancedLabel(resolved.plan) : basicLabel(resolved.plan);
}

function expectedOutput(resolved: ResolvedAnalyticalPlan): ExpectedOutput {
  if (resolved.kind === "advanced") {
    if (resolved.plan.operation === "anti_join") return {
      grain: "list",
      columns: [{ label: fieldName(resolved.plan.entity), unit: null, expectedName: leaf(resolved.plan.entity) }],
    };
    const unit: AnalyticalNarrationUnit = resolved.plan.operation === "conditional_rate" || resolved.plan.operation === "period_growth"
      ? "percent"
      : resolved.plan.operation === "duration_average" ? "hours" : null;
    const names: Record<Exclude<AdvancedAnalyticalPlan["operation"], "anti_join">, string> = {
      ratio: "ratio",
      conditional_rate: "rate_pct",
      distinct_count: "distinct_count",
      duration_average: "average_duration_hours",
      threshold_count: "matching_entities",
      period_growth: "growth_pct",
      per_entity_average: "average_per_entity",
      aggregate_over_groups: "aggregate_over_groups",
    };
    return { grain: "scalar", columns: [{ label: analyticalNarrationLabel(resolved), unit, expectedName: names[resolved.plan.operation] }] };
  }
  if (!resolved.plan.dimensions.length) return {
    grain: "scalar",
    columns: [{ label: basicLabel(resolved.plan), unit: null, expectedName: resolved.plan.alias }],
  };
  const dimensionLabels = uniqueDimensionLabels(resolved.plan.dimensions);
  const dimensions = resolved.plan.dimensions.map((dimension, index) => ({
    label: dimensionLabels[index],
    unit: null as AnalyticalNarrationUnit,
    expectedName: leaf(dimension),
    allowEngineDisambiguation: true,
  }));
  return {
    grain: "table",
    columns: [...dimensions, {
      label: aggregateLabel(resolved.plan.aggregate, resolved.plan.metric, resolved.plan.source),
      unit: null,
      expectedName: resolved.plan.alias,
    }],
  };
}

function outputShapeIsValid(resolved: ResolvedAnalyticalPlan, result: SqlExecutionResult) {
  const expected = expectedOutput(resolved);
  if (!result.columns.length || result.columns.length !== expected.columns.length) return false;
  if (result.columns.some((column, index) => {
    const definition = expected.columns[index];
    if (column === definition.expectedName) return false;
    return !(definition.allowEngineDisambiguation && new RegExp(`^${definition.expectedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:_\\d+)?$`).test(column));
  })) return false;
  if (result.rows.some((row) => row.length !== result.columns.length)) return false;
  if (expected.grain === "scalar" && result.rows.length !== 1) return false;
  return true;
}

function displayValue(value: unknown, unit: AnalyticalNarrationUnit) {
  const text = escaped(rawCellText(value));
  if (value === null) return { text: "null", shortened: false };
  if (unit === "percent") return { text: `${text.text}%`, shortened: text.shortened };
  if (unit === "hours") return { text: `${text.text} hours`, shortened: text.shortened };
  return text;
}

function cellFacts(resolved: ResolvedAnalyticalPlan, result: SqlExecutionResult, displayedRows: number, displayedColumns: number): AnalyticalNarrationFact[] {
  const output = expectedOutput(resolved);
  const facts: AnalyticalNarrationFact[] = [];
  for (let row = 0; row < displayedRows; row += 1) {
    for (let column = 0; column < displayedColumns; column += 1) {
      facts.push({
        id: `cell:${row}:${column}`,
        kind: "cell",
        label: output.columns[column]?.label ?? words(result.columns[column]),
        value: rawCellText(result.rows[row][column]),
        unit: output.columns[column]?.unit ?? null,
        cell: { row, column },
      });
    }
  }
  return facts;
}

function displayLimitations(resolved: ResolvedAnalyticalPlan, result: SqlExecutionResult, displayedRows: number, displayedColumns: number, scope: ReturnType<typeof scopeFor>) {
  const items: string[] = [];
  if (result.receipt.truncated) items.push("The runtime row limit was reached, so this is a partial result.");
  else if (result.rows.length > displayedRows) items.push(`Showing ${displayedRows} of ${result.rows.length} returned rows.`);
  if (result.columns.length > displayedColumns) items.push(`Showing ${displayedColumns} of ${result.columns.length} returned columns.`);
  const output = expectedOutput(resolved);
  const shortenedCell = result.rows.slice(0, displayedRows).some((row) => row.slice(0, displayedColumns).some((value, column) => displayValue(value, output.columns[column]?.unit ?? null).shortened));
  if (shortenedCell) items.push("Some long cell values were visibly shortened with an ellipsis.");
  const shortenedLabel = escaped(analyticalNarrationLabel(resolved)).shortened
    || output.columns.slice(0, displayedColumns).some((column) => escaped(column.label).shortened);
  if (shortenedLabel) items.push("Some long analytical labels were visibly shortened with an ellipsis.");
  if (scope.shortened) items.push("Some long filter labels or values were visibly shortened with an ellipsis.");
  if (scope.omitted) items.push("Additional verified filters were omitted from the display; the calculation query retains them.");
  return items;
}

function renderTable(result: SqlExecutionResult, resolved: ResolvedAnalyticalPlan, displayedRows: number, displayedColumns: number) {
  const output = expectedOutput(resolved);
  const headers = output.columns.slice(0, displayedColumns).map((column) => capitalized(column.label));
  const rows = result.rows.slice(0, displayedRows).map((row) => row.slice(0, displayedColumns).map((value, column) => displayValue(value, output.columns[column]?.unit ?? null).text));
  return [
    `| ${headers.map(safeTableCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function joinSections(parts: string[]) {
  return parts.filter(Boolean).join("\n\n");
}

export function compileVerifiedAnalyticalNarration(resolved: ResolvedAnalyticalPlan, result: SqlExecutionResult): VerifiedAnalyticalNarration {
  const label = analyticalNarrationLabel(resolved);
  const labelDisplay = safeInline(label);
  const output = expectedOutput(resolved);
  const displayedRows = Math.min(result.rows.length, maximumRenderedRows);
  const displayedColumns = Math.min(result.columns.length, maximumRenderedColumns);
  const scope = scopeFor(resolved);
  const limitations = displayLimitations(resolved, result, displayedRows, displayedColumns, scope);
  const complete = limitations.length === 0;
  const facts = cellFacts(resolved, result, displayedRows, displayedColumns);
  const rowFact: AnalyticalNarrationFact = { id: "receipt:rows", kind: "row-count", label: "returned rows", value: String(result.receipt.returnedRows), unit: null };
  const columnFact: AnalyticalNarrationFact = { id: "receipt:columns", kind: "column-count", label: "returned columns", value: String(result.columns.length), unit: null };
  if (limitations.length) facts.push({ id: "receipt:completeness", kind: "completeness", label: "result completeness", value: limitations.join(" "), unit: null });
  const limitationText = limitations.join(" ");

  if (!result.rows.length) {
    const claim = `${labelDisplay}: the verified calculation returned no matching rows.`;
    return {
      contractVersion: ANALYTICAL_NARRATION_CONTRACT_VERSION,
      mode: "empty",
      label,
      facts: [rowFact, columnFact, ...facts],
      claims: [claim, ...scope.claims, ...limitations],
      complete,
      displayedRows,
      displayedColumns,
      answer: joinSections([
        `**${labelDisplay}:** no matching rows were returned by the verified calculation. This does not prove that the underlying phenomenon is absent.`,
        scope.text,
        limitationText,
      ]),
    };
  }

  if (output.grain === "scalar") {
    const unit = output.columns[0]?.unit ?? null;
    const value = displayValue(result.rows[0]?.[0], unit).text;
    const claim = `${labelDisplay}: ${value}.`;
    const direct = result.rows[0]?.[0] === null
      ? `**${labelDisplay}:** the verified calculation returned **null**, so no value is available.`
      : `**${labelDisplay}:** **${value}**.`;
    return {
      contractVersion: ANALYTICAL_NARRATION_CONTRACT_VERSION,
      mode: "scalar",
      label,
      facts: [rowFact, columnFact, ...facts],
      claims: [claim, ...scope.claims, ...limitations],
      complete,
      displayedRows,
      displayedColumns,
      answer: joinSections([direct, scope.text, limitationText]),
    };
  }

  const mode: AnalyticalNarrationMode = output.grain;
  const rowCountClaim = `${labelDisplay}: ${result.receipt.returnedRows} verified row${result.receipt.returnedRows === 1 ? "" : "s"} returned.`;
  return {
    contractVersion: ANALYTICAL_NARRATION_CONTRACT_VERSION,
    mode,
    label,
    facts: [rowFact, columnFact, ...facts],
    claims: [rowCountClaim, ...scope.claims, ...limitations],
    complete,
    displayedRows,
    displayedColumns,
    answer: joinSections([
      `**${labelDisplay}:** ${result.receipt.returnedRows} verified row${result.receipt.returnedRows === 1 ? "" : "s"} returned.`,
      scope.text,
      renderTable(result, resolved, displayedRows, displayedColumns),
      limitationText,
    ]),
  };
}

function numericClaims(value: string) {
  return value.match(/(?<![\p{L}\p{N}_])-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?(?![\p{L}\p{N}_])/gu)?.map((token) => token.replaceAll(",", "").replace("%", "")) ?? [];
}

function planNumbers(resolved: ResolvedAnalyticalPlan) {
  const { explanation: _explanation, ...trustedPlan } = resolved.plan;
  void _explanation;
  return new Set(numericClaims(JSON.stringify(trustedPlan)));
}

export function auditVerifiedAnalyticalNarration(narration: VerifiedAnalyticalNarration, resolved: ResolvedAnalyticalPlan, result: SqlExecutionResult): VerifiedAnalyticalNarrationAudit {
  const failures = new Set<VerifiedAnalyticalNarrationAudit["failures"][number]>();
  if (result.receipt.returnedRows !== result.rows.length
    || result.receipt.returnedRows > result.receipt.rowLimit
    || result.receipt.truncated && result.receipt.returnedRows !== result.receipt.rowLimit) failures.add("receipt-mismatch");
  if (!outputShapeIsValid(resolved, result)) failures.add("shape-mismatch");
  const ids = new Set<string>();
  for (const fact of narration.facts) {
    if (ids.has(fact.id)) failures.add("duplicate-fact");
    ids.add(fact.id);
    if (!fact.cell) continue;
    if (!Number.isInteger(fact.cell.row) || !Number.isInteger(fact.cell.column)
      || fact.cell.row < 0 || fact.cell.row >= Math.min(result.rows.length, maximumRenderedRows)
      || fact.cell.column < 0 || fact.cell.column >= Math.min(result.columns.length, maximumRenderedColumns)
      || fact.cell.column >= result.rows[fact.cell.row].length) failures.add("invalid-bound");
    else if (rawCellText(result.rows[fact.cell.row][fact.cell.column]) !== fact.value) failures.add("cell-mismatch");
  }
  const allowedNumbers = planNumbers(resolved);
  for (const token of numericClaims(JSON.stringify({
    label: analyticalNarrationLabel(resolved),
    columns: expectedOutput(resolved).columns.map((column) => column.label),
  }))) allowedNumbers.add(token);
  for (const token of numericClaims(JSON.stringify({
    rows: result.rows.slice(0, maximumRenderedRows).map((row) => row.slice(0, maximumRenderedColumns)),
    returnedRows: result.receipt.returnedRows,
    returnedColumns: result.columns.length,
    displayedRows: narration.displayedRows,
    displayedColumns: narration.displayedColumns,
  }))) allowedNumbers.add(token);
  for (const token of numericClaims(narration.answer)) if (!allowedNumbers.has(token)) failures.add("unsupported-number");
  const canonical = compileVerifiedAnalyticalNarration(resolved, result);
  if (JSON.stringify(narration) !== JSON.stringify(canonical)) failures.add("canonical-mismatch");
  return { valid: failures.size === 0, failures: [...failures] };
}
