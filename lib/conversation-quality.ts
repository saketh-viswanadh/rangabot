import type { AnswerContract } from "./conversation-contract.ts";
import { latestUserRequest, normalizeContractAnswer, semanticContractRepairs } from "./conversation-contract.ts";
import { ProviderError, type ChatMessage, type GenerationOptions } from "./providers/types.ts";

export type ReviewStatus = "skipped" | "passed" | "revised" | "invalid-review" | "rejected-revision";
export type ReviewedAnswer = { answer: string; status: ReviewStatus; issues: string[] };
type CompleteJson = (messages: ChatMessage[], options?: GenerationOptions) => Promise<string>;

const reviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "issues", "revisedAnswer"],
  properties: {
    verdict: { type: "string", enum: ["pass", "revise"] },
    issues: { type: "array", items: { type: "string" } },
    revisedAnswer: { type: "string" },
  },
} as const;

const substantiveRequest = /\b(?:explain|compare|recommend|calculate|compute|choose|diagnos\w*|analy[sz]\w*|evaluate|why|what is|which|should|teach|summari[sz]\w*|debug|investigat\w*|check)\b/i;

export function shouldReviewConversationAnswer(messages: ChatMessage[], contract: AnswerContract): boolean {
  if (contract.exactLiteral || contract.missingSourceMaterial || contract.commaSeparatedOnly) return false;
  return substantiveRequest.test(latestUserRequest(messages));
}

function parseReview(raw: string): { verdict: "pass" | "revise"; issues: string[]; revisedAnswer?: string } | null {
  try {
    const parsed = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, "")) as Record<string, unknown>;
    const verdict = typeof (parsed.verdict ?? parsed.status) === "string" ? String(parsed.verdict ?? parsed.status).toLowerCase() : "";
    if (verdict !== "pass" && verdict !== "revise") return null;
    const issues = parsed.issues ?? [];
    if (!Array.isArray(issues) || issues.length > 6 || issues.some((issue) => typeof issue !== "string" || issue.length > 240)) return null;
    const revisedAnswer = parsed.revisedAnswer ?? parsed.revised_answer ?? parsed.answer;
    if (verdict === "revise" && (typeof revisedAnswer !== "string" || !revisedAnswer.trim() || revisedAnswer.length > 50_000)) return null;
    return { verdict, issues: issues as string[], ...(typeof revisedAnswer === "string" ? { revisedAnswer: revisedAnswer.trim() } : {}) };
  } catch {
    return null;
  }
}

function contractViolationCount(answer: string, contract: AnswerContract): number {
  let count = semanticContractRepairs(answer, contract).length;
  const words = answer.trim().split(/\s+/).filter(Boolean).length;
  if (contract.maxWords && words > contract.maxWords) count += 1;
  if (contract.exactWords && words !== contract.exactWords) count += 1;
  if (contract.list?.style === "numbered" && (answer.match(/^\s*\d+[.)]\s+/gm)?.length ?? 0) !== contract.list.count) count += 1;
  if (contract.list?.style === "bullets" && (answer.match(/^\s*[-*+•]\s+/gm)?.length ?? 0) !== contract.list.count) count += 1;
  if (contract.noBullets && /^\s*(?:[-*+•]|\d+[.)])\s+/m.test(answer)) count += 1;
  for (const term of contract.forbiddenTerms) if (answer.toLowerCase().includes(term.toLowerCase())) count += 1;
  return count;
}

export async function reviewConversationAnswer(input: {
  messages: ChatMessage[];
  contractMessages: ChatMessage[];
  contract: AnswerContract;
  draft: string;
  completeJson: CompleteJson;
  signal?: AbortSignal;
  force?: boolean;
}): Promise<ReviewedAnswer> {
  if (!input.force && !shouldReviewConversationAnswer(input.contractMessages, input.contract)) return { answer: input.draft, status: "skipped", issues: [] };
  const reviewMessages: ChatMessage[] = [
    ...input.messages,
    { role: "assistant", content: input.draft.slice(0, 50_000) },
    {
      role: "system",
      content: `You are Rangabot's private local answer reviewer. Judge the draft against the latest user request, current corrections, relevant conversation, and output contract above.

Check only material defects:
- factual, numerical, or causal errors;
- failure to answer the actual question or choose when asked;
- ignored constraints, audience, or correction;
- unsupported claims about current data or completed actions;
- irrelevant or missing reasoning that makes the answer unusable.
- role labels, grading language, "request decision" summaries, or other internal/meta commentary.

First solve or reason through the request independently, including recomputing every supplied number, then compare that result with the draft. Do not assume fluent wording is correct. Do not demand extra detail or rewrite merely for style. User-approved memory is context, not verified evidence. If the draft is materially sound, return {"verdict":"pass","issues":[],"revisedAnswer":"the unchanged draft"}. If not, return {"verdict":"revise","issues":["short concrete issue"],"revisedAnswer":"complete corrected answer"}. Return valid JSON only. Never discuss this review process in the answer.`,
    },
  ];
  let reviewed;
  try {
    reviewed = parseReview(await input.completeJson(reviewMessages, { signal: input.signal, numPredict: 1200, timeoutMs: 120_000, jsonSchema: reviewSchema }));
  } catch (error) {
    if (error instanceof ProviderError && error.code === "resource-limit") throw error;
    return { answer: input.draft, status: "invalid-review", issues: [] };
  }
  if (!reviewed) return { answer: input.draft, status: "invalid-review", issues: [] };
  if (reviewed.verdict === "pass") return { answer: input.draft, status: "passed", issues: [] };
  const rawRevision = reviewed.revisedAnswer!;
  const revised = normalizeContractAnswer(rawRevision, input.contract);
  const draft = normalizeContractAnswer(input.draft, input.contract);
  if (contractViolationCount(rawRevision, input.contract) > contractViolationCount(input.draft, input.contract)
    || contractViolationCount(revised, input.contract) > contractViolationCount(draft, input.contract)) {
    return { answer: draft, status: "rejected-revision", issues: reviewed.issues };
  }
  return { answer: revised, status: "revised", issues: reviewed.issues };
}
