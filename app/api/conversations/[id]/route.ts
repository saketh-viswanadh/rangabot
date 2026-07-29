import { NextResponse } from "next/server";
import { deleteConversation, getConversation, setConversationPinned, updateConversation } from "@/lib/conversations";
import { isValidChatMessages } from "@/lib/chat-validation";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const conversation = getConversation((await context.params).id);
  return conversation
    ? NextResponse.json({ conversation })
    : NextResponse.json({ error: "Conversation not found." }, { status: 404 });
}

export async function PUT(request: Request, context: RouteContext) {
  const body = (await request.json()) as { messages?: unknown };
  if (!isValidChatMessages(body.messages, { allowEmpty: true })) {
    return NextResponse.json({ error: "Valid messages are required." }, { status: 400 });
  }
  const conversation = updateConversation((await context.params).id, body.messages);
  return conversation
    ? NextResponse.json({ conversation })
    : NextResponse.json({ error: "Conversation not found." }, { status: 404 });
}

export async function DELETE(_request: Request, context: RouteContext) {
  return deleteConversation((await context.params).id)
    ? new Response(null, { status: 204 })
    : NextResponse.json({ error: "Conversation not found." }, { status: 404 });
}

export async function PATCH(request: Request, context: RouteContext) {
  const body = (await request.json()) as { pinned?: unknown };
  if (typeof body.pinned !== "boolean") {
    return NextResponse.json({ error: "A boolean pinned value is required." }, { status: 400 });
  }
  const conversation = setConversationPinned((await context.params).id, body.pinned);
  return conversation
    ? NextResponse.json({ conversation })
    : NextResponse.json({ error: "Conversation not found." }, { status: 404 });
}
