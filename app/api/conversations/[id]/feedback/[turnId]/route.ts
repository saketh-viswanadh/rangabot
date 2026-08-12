import { NextResponse } from "next/server";
import { getConversationDatabase } from "@/lib/conversations";
import { isResponseFeedbackRating, type ResponseFeedbackRating } from "@/lib/response-feedback-contract";
import { setResponseFeedback } from "@/lib/response-feedback";
import { StaleProfileRequestError, withProfileRequest } from "@/lib/profile-request";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string; turnId: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  let body: unknown;
  try { body = await request.json(); }
  catch {
    return NextResponse.json({ error: "A valid JSON feedback update is required." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "A feedback rating or null is required." }, { status: 400 });
  }
  const record = body as Record<string, unknown>;
  const rating = record.rating as ResponseFeedbackRating | null;
  if (Object.keys(record).length !== 1 || !Object.prototype.hasOwnProperty.call(record, "rating")
    || (rating !== null && !isResponseFeedbackRating(rating))) {
    return NextResponse.json({ error: "Feedback must be helpful, needs-improvement, or null." }, { status: 400 });
  }
  try {
    return await withProfileRequest(request, { kind: "database-mutation", label: "response feedback update" }, async () => {
      const { id, turnId } = await context.params;
      const result = setResponseFeedback(getConversationDatabase(), id, turnId, rating);
      return result.kind === "updated"
        ? NextResponse.json({ feedback: result.feedback, outcome: result.outcome })
        : NextResponse.json({ error: "That completed response is not eligible for feedback." }, { status: 404 });
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Feedback was not saved." }, { status: error instanceof StaleProfileRequestError ? 409 : 500 });
  }
}
