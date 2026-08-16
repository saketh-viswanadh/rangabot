"use client";

import { useState } from "react";
import { localApiFetch } from "@/lib/local-api-client";
import { CraftIcon } from "@/app/components/craft-icon";
import {
  RESPONSE_FEEDBACK_CONFIRMATIONS,
  expectedResponseFeedbackOutcome,
  isResponseFeedbackRating,
  nextResponseFeedbackRating,
  type ResponseFeedbackMutationOutcome,
  type ResponseFeedbackRating,
} from "@/lib/response-feedback-contract";

type ResponseFeedbackProps = {
  conversationId: string;
  turnId: string;
  rating: ResponseFeedbackRating | null;
  onRatingChange: (turnId: string, rating: ResponseFeedbackRating | null) => void;
};

export function ResponseFeedback({ conversationId, turnId, rating, onRatingChange }: ResponseFeedbackProps) {
  const [saving, setSaving] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  async function activate(activated: ResponseFeedbackRating) {
    if (saving) return;
    const previous = rating;
    const next = nextResponseFeedbackRating(previous, activated);
    const intendedOutcome = expectedResponseFeedbackOutcome(previous, next);
    setSaving(true);
    onRatingChange(turnId, next);
    setAnnouncement("");
    try {
      const response = await localApiFetch(`/api/conversations/${conversationId}/feedback/${turnId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: next }),
      });
      const body = await response.json() as {
        feedback?: { turnId?: unknown; rating?: unknown };
        outcome?: unknown;
      };
      const persistedRating = body.feedback?.rating;
      if (!response.ok || body.feedback?.turnId !== turnId
        || (persistedRating !== null && !isResponseFeedbackRating(persistedRating))) {
        throw new Error("The local feedback update was not confirmed.");
      }
      const outcome = body.outcome === "saved" || body.outcome === "changed" || body.outcome === "cleared"
        || body.outcome === "unchanged"
        ? body.outcome as ResponseFeedbackMutationOutcome
        : intendedOutcome;
      onRatingChange(turnId, persistedRating);
      const confirmed = outcome === "unchanged" ? intendedOutcome : outcome;
      setAnnouncement(RESPONSE_FEEDBACK_CONFIRMATIONS[confirmed]);
    } catch {
      onRatingChange(turnId, previous);
      setAnnouncement(RESPONSE_FEEDBACK_CONFIRMATIONS.failure);
    } finally {
      setSaving(false);
    }
  }

  return (
    <fieldset className="response-feedback" aria-busy={saving} aria-label="Optional response feedback">
      <legend className="visually-hidden">Was this response helpful?</legend>
      <div className="response-feedback-options">
        <button
          type="button"
          className={rating === "helpful" ? "selected" : ""}
          aria-pressed={rating === "helpful"}
          aria-label="Helpful"
          title="Helpful"
          disabled={saving}
          onClick={() => void activate("helpful")}
        >
          <CraftIcon name="thumb-up" size={14} />
        </button>
        <button
          type="button"
          className={rating === "needs-improvement" ? "selected" : ""}
          aria-pressed={rating === "needs-improvement"}
          aria-label="Needs improvement"
          title="Needs improvement"
          disabled={saving}
          onClick={() => void activate("needs-improvement")}
        >
          <CraftIcon name="thumb-down" size={14} />
        </button>
      </div>
      <span className="response-feedback-status" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
    </fieldset>
  );
}
