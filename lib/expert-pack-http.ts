import type { ExpertPackFailureCode } from "./expert-packs.ts";

const expertPackFailureStatuses: Record<ExpertPackFailureCode, number> = {
  cancelled: 499,
  "capability-unavailable": 400,
  "invalid-output": 400,
  "model-missing": 503,
  "model-unqualified": 400,
  "permission-required": 400,
  "provider-failure": 502,
  "provider-unavailable": 503,
  "resource-limit": 400,
  timeout: 504,
  "tool-failure": 502,
};

export function expertPackFailureStatus(code: ExpertPackFailureCode | undefined) {
  return code ? expertPackFailureStatuses[code] : 500;
}
