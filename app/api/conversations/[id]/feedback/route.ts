import { NextResponse } from "next/server";
import { getConversationDatabase } from "@/lib/conversations";
import { listConversationResponseFeedback } from "@/lib/response-feedback";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const id = (await context.params).id;
  const database = getConversationDatabase();
  const conversation = database.prepare("SELECT 1 AS present FROM conversations WHERE id = ?").get(id);
  if (!conversation) {
    return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  }
  return NextResponse.json({ responseFeedback: listConversationResponseFeedback(database, id) });
}
