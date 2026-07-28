import { NextResponse } from "next/server";
import { conversationFilename, serializeConversationMarkdown } from "@/lib/conversation-markdown";
import { getConversation } from "@/lib/conversations";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const conversation = getConversation((await context.params).id);
  if (!conversation) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  return new Response(serializeConversationMarkdown(conversation), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${conversationFilename(conversation.title)}"`,
      "Cache-Control": "no-store",
    },
  });
}
