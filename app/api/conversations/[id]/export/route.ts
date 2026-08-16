import { NextResponse } from "next/server";
import { conversationFilename, serializeConversationMarkdown } from "@/lib/conversation-markdown";
import { getConversation } from "@/lib/conversations";
import { StaleProfileRequestError, withProfileRequest } from "@/lib/profile-request";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    return await withProfileRequest(request, { kind: "export", label: "conversation export" }, async () => {
      const conversation = getConversation((await context.params).id);
      if (!conversation) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
      return new Response(serializeConversationMarkdown(conversation), {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="${conversationFilename(conversation.title)}"`,
          "Cache-Control": "no-store",
        },
      });
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The conversation could not be exported." }, { status: error instanceof StaleProfileRequestError ? 409 : 500 });
  }
}
