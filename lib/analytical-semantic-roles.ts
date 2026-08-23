import type { DatasetColumn } from "./sql-runtime.ts";

export type SemanticRoleCandidate = {
  field: string;
  score: number;
  evidence: string[];
};

export type ResolvedSemanticRole = {
  value: string | null;
  confidence: "high" | "ambiguous" | "none";
  candidates: SemanticRoleCandidate[];
};

export type AnalyticalSemanticRoles = {
  countTarget: ResolvedSemanticRole;
  group: ResolvedSemanticRole;
  measure: ResolvedSemanticRole;
  secondaryMeasure: ResolvedSemanticRole;
  startTime: ResolvedSemanticRole;
  endTime: ResolvedSemanticRole;
  dateField: ResolvedSemanticRole;
  populationRelation: ResolvedSemanticRole;
  denominatorRelation: ResolvedSemanticRole;
  thresholdEntity: ResolvedSemanticRole;
  thresholdRelation: ResolvedSemanticRole;
  unmatchedEntity: ResolvedSemanticRole;
  relatedRelation: ResolvedSemanticRole;
};

type Role = "identifier" | "group" | "measure" | "time";

function stem(word: string) {
  if (word.length > 4 && word.endsWith("ied")) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}

function tokens(value: string) {
  return value.toLocaleLowerCase().replaceAll("_", " ").match(/[\p{L}\p{N}]+/gu)?.map(stem) ?? [];
}

function fieldName(column: DatasetColumn) {
  return column.table ? `${column.table}.${column.name}` : column.name;
}

function isNumeric(column: DatasetColumn) { return /INT|DECIMAL|DOUBLE|REAL|FLOAT|NUMERIC/i.test(column.type); }
function isTemporal(column: DatasetColumn) { return /DATE|TIME/i.test(column.type); }
function isIdentifier(column: DatasetColumn) { return column.name.endsWith("_id"); }

function canonicalIdentifier(column: DatasetColumn) {
  if (!column.table || !isIdentifier(column)) return false;
  const root = stem(column.name.slice(0, -3).toLocaleLowerCase());
  const table = tokens(column.table);
  return table.length === 1 && table[0] === root;
}

function phrase(pattern: RegExp, request: string) {
  return request.match(pattern)?.[1]?.trim() ?? "";
}

function rolePhrases(request: string) {
  const group = phrase(/\b(?:per|by|for each)\s+(.+?)(?=\b(?:where|with|who|that|during|from|between|in)\b|[?.!,]|$)/i, request);
  const countTarget = phrase(/\b(?:number|count)\s+(?:of\s+)?(.+?)\s+(?:per|by|for each)\b/i, request)
    || phrase(/\b(?:distinct|unique)\s+(.+?)(?=\b(?:who|that|which|with|having|at least|per|by)\b|[?.!,]|$)/i, request);
  const measure = phrase(/\b(?:average|mean)\s+(?:the\s+)?(?:total\s+)?(.+?)\s+(?:per|by|for each)\b/i, request)
    || phrase(/\b(?:total|sum of)\s+(.+?)(?=\s+divided by|\s+(?:per|by)\b|[?.!,]|$)/i, request)
    || phrase(/\bratio\s+of\s+(?:total\s+)?(.+?)\s+divided by\b/i, request)
    || phrase(/\bgrowth\s+(?:in|of)\s+(?:total\s+)?(.+?)(?=\s+(?:using|from|between)\b|[?.!,]|$)/i, request);
  const secondaryMeasure = phrase(/\bdivided by\s+(?:the\s+)?(?:total\s+)?(.+?)(?=[?.!,]|$)/i, request);
  const startTime = phrase(/\b(?:between|from)\s+([a-zA-Z0-9_ ]+?)\s+(?:and|to)\b/i, request);
  const endTime = phrase(/\b(?:between|from)\s+[a-zA-Z0-9_ ]+?\s+(?:and|to)\s+([a-zA-Z0-9_ ]+?)(?=\s+in\s+(?:hours?|minutes?|days?)\b|[?.!,]|$)/i, request);
  const denominatorRelation = phrase(/\bdivided by\s+(?:the\s+)?(?:total\s+)?(.+?)(?=[?.!,]|$)/i, request);
  const thresholdEntity = phrase(/\bhow many\s+(.+?)\s+(?:have|had|with)\s+at least\b/i, request);
  const thresholdRelation = phrase(/\bat least\s+\d+\s+(.+?)(?=[?.!,]|$)/i, request);
  const unmatchedEntity = phrase(/\b(?:which|what)\s+(.+?)\s+(?:(?:were|was|are|is)\s+)?(?:never|without)\b/i, request)
    || phrase(/\b(?:which|what)\s+(.+?)\s+(?:have|has|had)\s+no\s+(?:related\s+)?/i, request);
  const relatedRelation = phrase(/\b(?:never|without)\s+(?:(?:linked|matched|associated)\s+to\s+|(?:had|having|with)\s+|any\s+)?(.+?)(?=[?.!,]|$)/i, request)
    || phrase(/\b(?:have|has|had)\s+no\s+(?:related\s+)?(.+?)(?=[?.!,]|$)/i, request);
  return { countTarget, group, measure, secondaryMeasure, startTime, endTime, denominatorRelation, thresholdEntity, thresholdRelation, unmatchedEntity, relatedRelation };
}

function eligible(column: DatasetColumn, role: Role) {
  if (!column.table) return false;
  if (role === "identifier") return isIdentifier(column);
  if (role === "measure") return isNumeric(column) && !isIdentifier(column);
  if (role === "time") return isTemporal(column);
  return !isTemporal(column) && (!isNumeric(column) || isIdentifier(column));
}

function rank(phraseText: string, request: string, columns: DatasetColumn[], role: Role): ResolvedSemanticRole {
  const orderedPhraseTokens = tokens(phraseText);
  const phraseTokens = new Set(orderedPhraseTokens);
  if (!phraseTokens.size) return { value: null, confidence: "none", candidates: [] };
  const requestTokens = new Set(tokens(request));
  const candidates = columns.filter((column) => eligible(column, role)).map((column) => {
    const columnTokens = tokens(column.name).filter((word) => word !== "id");
    const tableTokens = tokens(column.table ?? "");
    const fieldOverlap = columnTokens.filter((word) => phraseTokens.has(word)).length;
    const tableOverlap = tableTokens.filter((word) => phraseTokens.has(word)).length;
    const requestNamesTable = tableTokens.length > 0 && containsTokenSequence(tokens(request), tableTokens);
    const evidence: string[] = [];
    if (fieldOverlap === 0 && tableOverlap === 0) return { field: fieldName(column), score: 0, evidence };
    if ((role === "measure" || role === "time") && fieldOverlap === 0) return { field: fieldName(column), score: 0, evidence };
    if (role === "measure" && tableTokens.length > 0 && [...phraseTokens].every((word) => tableTokens.includes(word))
      && columnTokens.some((word) => !phraseTokens.has(word))) return { field: fieldName(column), score: 0, evidence };
    let score = fieldOverlap * 8 + tableOverlap * 6;
    if (fieldOverlap) evidence.push("phrase matches field");
    if (tableOverlap) evidence.push("phrase matches relation");
    if (requestNamesTable) { score += 8; evidence.push("request names relation"); }
    if (role === "identifier") {
      const mention = [...columnTokens, ...tableTokens].map((word) => orderedPhraseTokens.indexOf(word)).filter((index) => index >= 0).sort((left, right) => left - right)[0];
      if (mention !== undefined) { score += Math.max(0, 10 - mention * 3); evidence.push("early population mention"); }
    }
    if (role === "identifier" && canonicalIdentifier(column)) { score += 3; evidence.push("canonical entity key"); }
    if (role === "group" && columnTokens.length && columnTokens.every((word) => phraseTokens.has(word))) { score += 4; evidence.push("exact group label"); }
    if (role === "measure" && columnTokens.some((word) => requestTokens.has(word))) { score += 2; evidence.push("measure named in request"); }
    if (role === "time" && columnTokens.every((word) => phraseTokens.has(word))) { score += 5; evidence.push("exact time label"); }
    return { field: fieldName(column), score, evidence };
  }).filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.field.localeCompare(right.field));
  if (!candidates[0]) return { value: null, confidence: "none", candidates };
  const sameScore = candidates.filter((candidate) => candidate.score === candidates[0].score);
  if (sameScore.length > 1) {
    const names = new Set(sameScore.map((candidate) => candidate.field.split(".").at(-1)));
    if (names.size === 1) {
      const canonical = sameScore.find((candidate) => {
        const column = columns.find((item) => fieldName(item) === candidate.field);
        return column && canonicalIdentifier(column);
      });
      if (canonical) return { value: canonical.field, confidence: "high", candidates };
    }
    return { value: null, confidence: "ambiguous", candidates };
  }
  const margin = candidates[0].score - (candidates[1]?.score ?? 0);
  return margin >= 3 ? { value: candidates[0].field, confidence: "high", candidates } : { value: null, confidence: "ambiguous", candidates };
}

function containsTokenSequence(haystack: string[], needle: string[]) {
  return needle.length > 0 && haystack.some((_, index) => needle.every((word, offset) => haystack[index + offset] === word));
}

function rankRelation(phraseText: string, columns: DatasetColumn[]): ResolvedSemanticRole {
  const phraseTokens = new Set(tokens(phraseText));
  if (!phraseTokens.size) return { value: null, confidence: "none", candidates: [] };
  const tables = [...new Set(columns.flatMap((column) => column.table ? [column.table] : []))];
  const candidates = tables.map((table) => {
    const tableTokens = tokens(table);
    const overlap = tableTokens.filter((word) => phraseTokens.has(word)).length;
    const exact = tableTokens.length > 0 && tableTokens.every((word) => phraseTokens.has(word));
    return { field: table, score: overlap * 8 + (exact ? 6 : 0), evidence: [...(overlap ? ["phrase matches relation"] : []), ...(exact ? ["complete relation label"] : [])] };
  }).filter((candidate) => candidate.score > 0).sort((left, right) => right.score - left.score || left.field.localeCompare(right.field));
  if (!candidates[0]) return { value: null, confidence: "none", candidates };
  const margin = candidates[0].score - (candidates[1]?.score ?? 0);
  return margin >= 4 ? { value: candidates[0].field, confidence: "high", candidates } : { value: null, confidence: "ambiguous", candidates };
}

/**
 * Resolves language into schema roles without selecting an operation or writing
 * SQL. It is deterministic, domain-neutral, and identical for every model.
 */
export function resolveAnalyticalSemanticRoles(request: string, columns: DatasetColumn[]): AnalyticalSemanticRoles {
  const phrases = rolePhrases(request);
  return {
    countTarget: rank(phrases.countTarget, request, columns, "identifier"),
    group: rank(phrases.group, request, columns, "group"),
    measure: rank(phrases.measure, request, columns, "measure"),
    secondaryMeasure: rank(phrases.secondaryMeasure, request, columns, "measure"),
    startTime: rank(phrases.startTime, request, columns, "time"),
    endTime: rank(phrases.endTime, request, columns, "time"),
    dateField: rank(request, request, columns, "time"),
    populationRelation: rankRelation(request, columns),
    denominatorRelation: rankRelation(phrases.denominatorRelation, columns),
    thresholdEntity: rank(phrases.thresholdEntity, request, columns, "identifier"),
    thresholdRelation: rankRelation(phrases.thresholdRelation, columns),
    unmatchedEntity: rank(phrases.unmatchedEntity, request, columns, "identifier"),
    relatedRelation: rankRelation(phrases.relatedRelation, columns),
  };
}
