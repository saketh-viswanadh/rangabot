import type { SqlExecutionResult } from "./sql-runtime.ts";

export const ANALYTICAL_RESULT_COMPARATOR_VERSION = "1.0.0";
// The analytical compiler intentionally renders numeric aggregates to two
// decimal places. This explicit evaluation tolerance permits only that display
// rounding, replacing the former implicit ±0.02 comparison.
export const ANALYTICAL_EVALUATION_TOLERANCE = { absoluteTolerance: 0.005000001, relativeTolerance: 1e-9 } as const;

export type AnalyticalResultMismatch =
  | "candidate-order-missing"
  | "column-count"
  | "nondeterministic-reference"
  | "row-count"
  | "row-values"
  | "row-width"
  | "truncated-result";

export type AnalyticalResultComparison = {
  comparatorVersion: typeof ANALYTICAL_RESULT_COMPARATOR_VERSION;
  passed: boolean;
  mismatch: AnalyticalResultMismatch | null;
  orderMode: "ordered" | "unordered";
  candidateShape: { columns: number; rows: number };
  referenceShape: { columns: number; rows: number };
  matchedRows: number;
  absoluteTolerance: number;
  relativeTolerance: number;
};

type ComparisonOptions = {
  candidateSql: string;
  referenceSql: string;
  absoluteTolerance?: number;
  relativeTolerance?: number;
};

type TopLevelSqlFeatures = { orderBy: boolean; limitOrOffset: boolean };

function topLevelSqlFeatures(sql: string): TopLevelSqlFeatures {
  const tokens: string[] = [];
  let token = "";
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let lineComment = false;
  let blockComment = false;

  const flush = () => {
    if (token) tokens.push(token.toLowerCase());
    token = "";
  };

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (char === quote && next === quote) { index += 1; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "-" && next === "-") { flush(); lineComment = true; index += 1; continue; }
    if (char === "/" && next === "*") { flush(); blockComment = true; index += 1; continue; }
    if (char === "'" || char === '"') { flush(); quote = char; continue; }
    if (char === "(") { flush(); depth += 1; continue; }
    if (char === ")") { flush(); depth = Math.max(0, depth - 1); continue; }
    if (depth === 0 && /[A-Za-z_]/.test(char)) token += char;
    else flush();
  }
  flush();

  return {
    orderBy: tokens.some((value, index) => value === "order" && tokens[index + 1] === "by"),
    limitOrOffset: tokens.some((value) => value === "limit" || value === "offset"),
  };
}

function objectValue(value: object) {
  try { return JSON.stringify(value); }
  catch { return null; }
}

function cellsMatch(left: unknown, right: unknown, absoluteTolerance: number, relativeTolerance: number) {
  if (left === null || right === null) return left === right;
  if (typeof left !== typeof right) return false;
  if (typeof left === "number" && typeof right === "number") {
    if (!Number.isFinite(left) || !Number.isFinite(right)) return Object.is(left, right);
    if (Number.isInteger(left) && Number.isInteger(right)) return left === right;
    return Math.abs(left - right) <= Math.max(absoluteTolerance, relativeTolerance * Math.max(Math.abs(left), Math.abs(right)));
  }
  if (typeof left === "string" || typeof left === "boolean" || typeof left === "bigint") return left === right;
  if (typeof left === "object" && typeof right === "object") return objectValue(left) === objectValue(right);
  return Object.is(left, right);
}

function rowsMatch(left: unknown[], right: unknown[], absoluteTolerance: number, relativeTolerance: number) {
  return left.length === right.length
    && left.every((value, index) => cellsMatch(value, right[index], absoluteTolerance, relativeTolerance));
}

function maximumRowMatching(candidateRows: unknown[][], referenceRows: unknown[][], absoluteTolerance: number, relativeTolerance: number) {
  const matchedCandidateByReference = Array<number>(referenceRows.length).fill(-1);
  const visit = (candidateIndex: number, seen: boolean[]): boolean => {
    for (let referenceIndex = 0; referenceIndex < referenceRows.length; referenceIndex += 1) {
      if (seen[referenceIndex] || !rowsMatch(candidateRows[candidateIndex], referenceRows[referenceIndex], absoluteTolerance, relativeTolerance)) continue;
      seen[referenceIndex] = true;
      if (matchedCandidateByReference[referenceIndex] === -1 || visit(matchedCandidateByReference[referenceIndex], seen)) {
        matchedCandidateByReference[referenceIndex] = candidateIndex;
        return true;
      }
    }
    return false;
  };

  let matchedRows = 0;
  for (let candidateIndex = 0; candidateIndex < candidateRows.length; candidateIndex += 1) {
    if (visit(candidateIndex, Array<boolean>(referenceRows.length).fill(false))) matchedRows += 1;
  }
  return matchedRows;
}

export function compareSqlResults(candidate: SqlExecutionResult, reference: SqlExecutionResult, options: ComparisonOptions): AnalyticalResultComparison {
  const absoluteTolerance = options.absoluteTolerance ?? 1e-9;
  const relativeTolerance = options.relativeTolerance ?? 1e-9;
  const referenceFeatures = topLevelSqlFeatures(options.referenceSql);
  const candidateFeatures = topLevelSqlFeatures(options.candidateSql);
  const orderMode = referenceFeatures.orderBy ? "ordered" : "unordered";
  const base = {
    comparatorVersion: ANALYTICAL_RESULT_COMPARATOR_VERSION,
    orderMode,
    candidateShape: { columns: candidate.columns.length, rows: candidate.rows.length },
    referenceShape: { columns: reference.columns.length, rows: reference.rows.length },
    absoluteTolerance,
    relativeTolerance,
  } as const;
  const fail = (mismatch: AnalyticalResultMismatch, matchedRows = 0): AnalyticalResultComparison => ({ ...base, passed: false, mismatch, matchedRows });

  if (candidate.receipt.truncated || reference.receipt.truncated) return fail("truncated-result");
  if (referenceFeatures.limitOrOffset && !referenceFeatures.orderBy) return fail("nondeterministic-reference");
  if (referenceFeatures.orderBy && !candidateFeatures.orderBy) return fail("candidate-order-missing");
  if (candidate.columns.length !== reference.columns.length) return fail("column-count");
  if (candidate.rows.some((row) => row.length !== candidate.columns.length)
    || reference.rows.some((row) => row.length !== reference.columns.length)) return fail("row-width");
  if (candidate.rows.length !== reference.rows.length) return fail("row-count");

  if (orderMode === "ordered") {
    let matchedRows = 0;
    for (let index = 0; index < reference.rows.length; index += 1) {
      if (!rowsMatch(candidate.rows[index], reference.rows[index], absoluteTolerance, relativeTolerance)) return fail("row-values", matchedRows);
      matchedRows += 1;
    }
    return { ...base, passed: true, mismatch: null, matchedRows };
  }

  const matchedRows = maximumRowMatching(candidate.rows, reference.rows, absoluteTolerance, relativeTolerance);
  return matchedRows === reference.rows.length
    ? { ...base, passed: true, mismatch: null, matchedRows }
    : fail("row-values", matchedRows);
}
