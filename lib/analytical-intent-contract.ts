import type { ResolvedAnalyticalPlan } from "./analytical-narration.ts";

export type AnalyticalIntentContract =
  | "conditional-rate"
  | "missing-relationships"
  | "complete-population-sum"
  | "complete-population-count-average"
  | "target-attainment"
  | "per-entity-average"
  | "partitioned-top-n"
  | "ordered-top-n";

export type AnalyticalIntentAudit = {
  expected: AnalyticalIntentContract | null;
  valid: boolean;
  explanation: string;
};

/**
 * Classifies only operation shapes whose accidental substitution produced a
 * materially wrong answer in the sealed readiness benchmark. This layer does
 * not choose fields or write SQL; it verifies that the typed plan selected by
 * either deterministic code or the local model preserves the user's semantic
 * postcondition before execution.
 */
export function expectedAnalyticalIntent(request: string): AnalyticalIntentContract | null {
  if (/\b(?:within|in|for)\s+(?:each|every)\b.{0,180}\b(?:top|highest|leading)\s+\d+\b/i.test(request)
    || /\b(?:top|highest|leading)\s+\d+\b.{0,180}\b(?:per|for each|within each|in each|in every)\b/i.test(request)) return "partitioned-top-n";
  if (/\b(?:target|attainment)\b/i.test(request) && /\b(?:percent|percentage)\b/i.test(request)) return "target-attainment";
  if (/\b(?:percent|percentage|rate)\b/i.test(request)
    && !/\b(?:growth|change|increase|decrease|ratio|divided by)\b/i.test(request)) return "conditional-rate";
  if (/\b(?:including|include)\b.{0,80}\b(?:zero|no)\b/i.test(request)
    && /\b(?:sum|total|revenue|amount|weight|value|cost|score|loss|fee|price|budget)\b/i.test(request)) return "complete-population-sum";
  if (/\beven\b.{0,80}\bno activity\b/i.test(request) && /\bshow zero\b/i.test(request)) return "complete-population-sum";
  if (/\b(?:average|mean)\b.{0,100}\b(?:number|count)\s+of\b/i.test(request)
    && /\b(?:none|no activity|zero)\b/i.test(request)) return "complete-population-count-average";
  if (/\b(?:which|what|list|show|return)\b.{0,100}\b(?:never|without|(?:have|has|had)\s+no\s+(?:related\s+)?)\b/i.test(request)) return "missing-relationships";
  if (/\b(?:average|mean)\s+of\s+each\b.{0,100}\btotal\b/i.test(request)
    || /\b(?:average|mean)\b.{0,40}\btotal\b.{0,80}\b(?:per|by|for each)\b/i.test(request)) return "per-entity-average";
  if (/\b(?:first|top|highest|leading)\s+\d+\b/i.test(request)) return "ordered-top-n";
  return null;
}

export function auditAnalyticalIntent(request: string, resolved: ResolvedAnalyticalPlan): AnalyticalIntentAudit {
  const expected = expectedAnalyticalIntent(request);
  if (!expected) return { expected, valid: true, explanation: "No protected operation-shape postcondition applies." };
  let valid = false;
  if (expected === "conditional-rate") valid = resolved.kind === "advanced" && resolved.plan.operation === "conditional_rate";
  else if (expected === "target-attainment") valid = resolved.kind === "advanced" && resolved.plan.operation === "target_attainment";
  else if (expected === "missing-relationships") valid = resolved.kind === "advanced" && resolved.plan.operation === "anti_join";
  else if (expected === "complete-population-sum") valid = resolved.kind === "advanced" && resolved.plan.operation === "complete_filtered_sum";
  else if (expected === "complete-population-count-average") valid = resolved.kind === "advanced" && resolved.plan.operation === "complete_count_average";
  else if (expected === "per-entity-average") valid = resolved.kind === "advanced" && resolved.plan.operation === "per_entity_average";
  else if (expected === "partitioned-top-n") valid = resolved.kind === "general"
    && resolved.plan.windows.some((window) => window.function === "row_number" && window.partitionBy.length > 0)
    && resolved.plan.qualify.some((condition) => condition.operator === "lte" && condition.value > 0)
    && resolved.plan.limit === 0;
  else valid = resolved.kind === "general" && resolved.plan.limit > 0 && resolved.plan.orderBy.length >= 2;
  return {
    expected,
    valid,
    explanation: valid
      ? `The typed plan preserves the ${expected} operation shape.`
      : `The requested ${expected} operation could not be mapped to a matching verified plan. Please name the population, relationship, measure, grouping, and tie-break explicitly.`,
  };
}
