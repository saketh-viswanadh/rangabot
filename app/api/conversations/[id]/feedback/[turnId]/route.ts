import { NextResponse } from "next/server";
import { getConversationDatabase } from "@/lib/conversations";
import { isResponseFeedbackRating } from "@/lib/response-feedback-contract";
import { setResponseFeedback } from "@/lib/response-feedback";

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
  if (Object.keys(record).length !== 1 || !Object.prototype.hasOwnProperty.call(record, "rating")
    || (record.rating !== null && !isResponseFeedbackRating(record.rating))) {
    return NextResponse.json({ error: "Feedback must be helpful, needs-improvement, or null." }, { status: 400 });
  }
  const { id, turnId } = await context.params;
  const result = setResponseFeedback(getConversationDatabase(), id, turnId, record.rating);
  return result.kind === "updated"
    ? NextResponse.json({ feedback: result.feedback, outcome: result.outcome })
    : NextResponse.json({ error: "That completed response is not eligible for feedback." }, { status: 404 });
}
