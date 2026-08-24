import { NextResponse } from "next/server";
import { isValidConversationTurnId } from "@/lib/conversation-turns";
import { StaleProfileRequestError, withProfileRequest } from "@/lib/profile-request";
import { prepareTurnRecovery, TurnRecoveryPreparationError } from "@/lib/turn-recovery-server";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "A conversation reference is required.", code: "invalid" }, { status: 400 }); }
  const id = (await context.params).id;
  if (!body || typeof body !== "object" || Array.isArray(body)
    || !Object.keys(body).every((key) => key === "conversationId")
    || !isValidConversationTurnId(id)
    || typeof (body as { conversationId?: unknown }).conversationId !== "string"
    || !(body as { conversationId: string }).conversationId
    || (body as { conversationId: string }).conversationId.length > 120) {
    return NextResponse.json({ error: "A valid failed conversation turn is required.", code: "invalid" }, { status: 400 });
  }
  const conversationId = (body as { conversationId: string }).conversationId;
  try {
    return await withProfileRequest(request, { kind: "tool-execution", label: "failed turn recovery preparation" }, async (signal) => {
      if (signal.aborted) return NextResponse.json({ error: "Recovery preparation was stopped.", code: "cancelled" }, { status: 499 });
      const recovery = await prepareTurnRecovery(id, conversationId, undefined, signal);
      if (signal.aborted) return NextResponse.json({ error: "Recovery preparation was stopped.", code: "cancelled" }, { status: 499 });
      return NextResponse.json({ recovery }, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) {
    if (error instanceof StaleProfileRequestError) return NextResponse.json({ error: error.message, code: "stale-profile" }, { status: 409 });
    if (error instanceof TurnRecoveryPreparationError) {
      const status = error.code === "not-found" ? 404 : error.code === "not-terminal" ? 409 : error.code === "integrity" ? 500 : 409;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    return NextResponse.json({ error: "The saved request could not be restored safely.", code: "internal" }, { status: 500 });
  }
}
