import { NextResponse } from "next/server";
import { createConversation, listConversations } from "@/lib/conversations";
import { isValidChatMessages } from "@/lib/chat-validation";
import { getApprovedDataset } from "@/lib/datasets";

export const runtime = "nodejs";

export function GET(request: Request) {
  const parameters = new URL(request.url).searchParams;
  const query = (parameters.get("query") ?? "").slice(0, 120);
  const projectId = parameters.get("projectId");
  return NextResponse.json({ conversations: listConversations({ query, projectId }) });
}

export async function POST(request: Request) {
  const body = (await request.json()) as { messages?: unknown; projectId?: unknown; datasetId?: unknown };
  if (!isValidChatMessages(body.messages, { allowEmpty: true }) || body.messages.some((message) => message.role === "system")) {
    return NextResponse.json({ error: "Valid messages are required." }, { status: 400 });
  }
  const projectId = typeof body.projectId === "string" ? body.projectId : null;
  if (body.datasetId !== undefined && typeof body.datasetId !== "string") {
    return NextResponse.json({ error: "Dataset attachment must be an approved dataset id." }, { status: 400 });
  }
  const datasetId = typeof body.datasetId === "string" ? body.datasetId : null;
  if (datasetId && !getApprovedDataset(datasetId)) {
    return NextResponse.json({ error: "That dataset is no longer approved." }, { status: 400 });
  }
  return NextResponse.json({ conversation: createConversation(body.messages, projectId, datasetId) }, { status: 201 });
}
