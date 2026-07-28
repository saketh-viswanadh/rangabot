import { NextResponse } from "next/server";
import { createConversation, listConversations } from "@/lib/conversations";
import type { ChatMessage } from "@/lib/providers/types";

export const runtime = "nodejs";

function validMessages(value: unknown): value is ChatMessage[] {
  return Array.isArray(value) && value.every((message) => (
    message
    && typeof message === "object"
    && ["user", "assistant", "system"].includes((message as ChatMessage).role)
    && typeof (message as ChatMessage).content === "string"
  ));
}

export function GET(request: Request) {
  const parameters = new URL(request.url).searchParams;
  const query = (parameters.get("query") ?? "").slice(0, 120);
  const projectId = parameters.get("projectId");
  return NextResponse.json({ conversations: listConversations({ query, projectId }) });
}

export async function POST(request: Request) {
  const body = (await request.json()) as { messages?: unknown; projectId?: unknown };
  if (!validMessages(body.messages)) {
    return NextResponse.json({ error: "Valid messages are required." }, { status: 400 });
  }
  const projectId = typeof body.projectId === "string" ? body.projectId : null;
  return NextResponse.json({ conversation: createConversation(body.messages, projectId) }, { status: 201 });
}
