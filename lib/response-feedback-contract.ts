export const RESPONSE_FEEDBACK_SCHEMA_VERSION = 1;
export const RESPONSE_FEEDBACK_EXCHANGE_TYPE = "response_feedback_daily" as const;

export type ResponseFeedbackRating = "helpful" | "needs-improvement";
export type ResponseFeedbackMutationOutcome = "saved" | "changed" | "cleared" | "unchanged";

export type ResponseFeedbackView = {
  turnId: string;
  rating: ResponseFeedbackRating | null;
};

export const RESPONSE_FEEDBACK_CONFIRMATIONS = Object.freeze({
  saved: "Feedback saved locally",
  changed: "Feedback changed locally",
  cleared: "Feedback cleared",
  failure: "Couldn’t save feedback on this device. Try again.",
});

export function isResponseFeedbackRating(value: unknown): value is ResponseFeedbackRating {
  return value === "helpful" || value === "needs-improvement";
}

export function nextResponseFeedbackRating(
  current: ResponseFeedbackRating | null,
  activated: ResponseFeedbackRating,
) {
  return current === activated ? null : activated;
}

export function expectedResponseFeedbackOutcome(
  previous: ResponseFeedbackRating | null,
  next: ResponseFeedbackRating | null,
): Exclude<ResponseFeedbackMutationOutcome, "unchanged"> {
  if (next === null) return "cleared";
  if (previous === null) return "saved";
  return "changed";
}
