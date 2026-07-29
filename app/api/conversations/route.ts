import { NextResponse } from "next/server";
import { createConversation, listConversations } from "@/lib/conversations";
import { isValidChatMessages } from "@/lib/chat-validation";

export const runtime = "nodejs";

export function GET(request: Request) {
  const parameters = new URL(request.url).searchParams;
  const query = (parameters.get("query") ?? "").slice(0, 120);
  const projectId = parameters.get("projectId");
  return NextResponse.json({ conversations: listConversations({ query, projectId }) });
}

export async function POST(request: Request) {
  const body = (await request.json()) as { messages?: unknown; projectId?: unknown };
  if (!isValidChatMessages(body.messages, { allowEmpty: true })) {
    return NextResponse.json({ error: "Valid messages are required." }, { status: 400 });
  }
  const projectId = typeof body.projectId === "string" ? body.projectId : null;
  return NextResponse.json({ conversation: createConversation(body.messages, projectId) }, { status: 201 });
}
