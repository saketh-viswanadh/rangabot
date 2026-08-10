import { NextResponse } from "next/server";
import { cancelConversationTurn, getConversationTurn, isValidConversationTurnId } from "@/lib/conversation-turns";
import { abortActiveConversationTurn } from "@/lib/active-conversation-turns";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const id = (await context.params).id;
  let body: { conversationId?: unknown };
  try { body = (await request.json()) as { conversationId?: unknown }; }
  catch { return NextResponse.json({ error: "A conversation reference is required." }, { status: 400 }); }
  if (!Object.keys(body).every((key) => key === "conversationId")
    || !isValidConversationTurnId(id) || typeof body.conversationId !== "string" || !body.conversationId || body.conversationId.length > 120) {
    return NextResponse.json({ error: "A valid conversation turn is required." }, { status: 400 });
  }
  const turn = getConversationTurn(id);
  if (!turn || turn.conversationId !== body.conversationId) {
    return NextResponse.json({ error: "Conversation turn not found." }, { status: 404 });
  }
  try {
    const terminal = cancelConversationTurn(id);
    abortActiveConversationTurn(id, new DOMException("Generation was stopped.", "AbortError"));
    return NextResponse.json({ turn: { id: terminal.id, status: terminal.status } });
  } catch {
    abortActiveConversationTurn(id, new DOMException("Generation was stopped.", "AbortError"));
    return NextResponse.json({ error: "The local turn could not be stopped safely.", code: "internal" }, { status: 500 });
  }
}
