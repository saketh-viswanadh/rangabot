import { NextResponse } from "next/server";
import { getConversationDatabase } from "@/lib/conversations";
import { listConversationResponseFeedback } from "@/lib/response-feedback";
import { profileBindingFromRequest, StaleProfileRequestError } from "@/lib/profile-request";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const id = (await context.params).id;
    profileBindingFromRequest(request);
    const database = getConversationDatabase();
    const conversation = database.prepare("SELECT 1 AS present FROM conversations WHERE id = ?").get(id);
    if (!conversation) {
      return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    }
    return NextResponse.json({ responseFeedback: listConversationResponseFeedback(database, id) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Response feedback could not be read." }, { status: error instanceof StaleProfileRequestError ? 409 : 500 });
  }
}
