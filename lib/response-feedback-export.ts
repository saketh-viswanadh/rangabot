import { RESPONSE_FEEDBACK_EXCHANGE_TYPE, RESPONSE_FEEDBACK_SCHEMA_VERSION } from "./response-feedback-contract.ts";
import type { ResponseFeedbackAggregateCounts } from "./response-feedback.ts";

export type ResponseFeedbackDailyEnvelope = {
  type: typeof RESPONSE_FEEDBACK_EXCHANGE_TYPE;
  data: {
    schemaVersion: 1;
    repository: "rangabot";
    build: string;
    buildDigest: string;
    sourceVersion: string;
    dirty: false;
    day: string;
    windowStart: string;
    windowEnd: string;
    eligibleResponses: number;
    helpful: number;
    needsImprovement: number;
    rated: number;
    unrated: number;
    generatedAt: string;
    sourceStatus: "COMPLETE";
    validationStatus: "VALID";
  };
};

function utcDayBounds(day: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("A UTC day in YYYY-MM-DD form is required.");
  const start = new Date(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(start.valueOf()) || start.toISOString().slice(0, 10) !== day) {
    throw new Error("A real UTC calendar day is required.");
  }
  const end = new Date(start.valueOf() + 86_400_000);
  return {
    windowStart: start.toISOString().replace(".000Z", "Z"),
    windowEnd: end.toISOString().replace(".000Z", "Z"),
    endTime: end.valueOf(),
  };
}

function secondsTimestamp(date: Date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function buildResponseFeedbackDailyEnvelope(input: {
  build: string;
  buildDigest: string;
  sourceVersion: string;
  day: string;
  counts: ResponseFeedbackAggregateCounts;
  generatedAt?: Date;
}): ResponseFeedbackDailyEnvelope {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(input.build)
    || !/^[0-9a-f]{7,64}$/.test(input.buildDigest)
    || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(input.sourceVersion)) {
    throw new Error("A registered build, lowercase build digest, and source version are required.");
  }
  const values = Object.values(input.counts);
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)
    || input.counts.rated !== input.counts.helpful + input.counts.needsImprovement
    || input.counts.unrated !== input.counts.eligibleResponses - input.counts.rated
    || input.counts.rated > input.counts.eligibleResponses) {
    throw new Error("Response feedback aggregate counts are inconsistent.");
  }
  const bounds = utcDayBounds(input.day);
  const generatedAt = input.generatedAt ?? new Date();
  if (!Number.isFinite(generatedAt.valueOf()) || generatedAt.valueOf() < bounds.endTime
    || generatedAt.valueOf() > Date.now() + 300_000) {
    throw new Error("Daily feedback can be exported only after its UTC window closes.");
  }
  return {
    type: RESPONSE_FEEDBACK_EXCHANGE_TYPE,
    data: {
      schemaVersion: RESPONSE_FEEDBACK_SCHEMA_VERSION,
      repository: "rangabot",
      build: input.build,
      buildDigest: input.buildDigest,
      sourceVersion: input.sourceVersion,
      dirty: false,
      day: input.day,
      windowStart: bounds.windowStart,
      windowEnd: bounds.windowEnd,
      eligibleResponses: input.counts.eligibleResponses,
      helpful: input.counts.helpful,
      needsImprovement: input.counts.needsImprovement,
      rated: input.counts.rated,
      unrated: input.counts.unrated,
      generatedAt: secondsTimestamp(generatedAt),
      sourceStatus: "COMPLETE",
      validationStatus: "VALID",
    },
  };
}
