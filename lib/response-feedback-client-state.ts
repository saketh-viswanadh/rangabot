import type { ResponseFeedbackRating } from "./response-feedback-contract.ts";

export type ResponseFeedbackClientMap = Record<string, ResponseFeedbackRating | null>;

export function mergeResponseFeedbackRead(
  remote: ResponseFeedbackClientMap,
  current: ResponseFeedbackClientMap,
  turnMutationRevisions: ReadonlyMap<string, number>,
  readStartedAtRevision: number,
) {
  const merged = { ...remote };
  for (const [turnId, revision] of turnMutationRevisions) {
    if (revision > readStartedAtRevision && Object.prototype.hasOwnProperty.call(current, turnId)) {
      merged[turnId] = current[turnId];
    }
  }
  return merged;
}

export function responseFeedbackBindingMatches(
  currentConversationId: string | null,
  currentGeneration: number,
  expectedConversationId: string,
  expectedGeneration: number,
) {
  return currentConversationId === expectedConversationId && currentGeneration === expectedGeneration;
}
