import { NextResponse } from "next/server";
import { deleteConversation, getConversation, setConversationDataset, setConversationPinned, updateConversation } from "@/lib/conversations";
import { isValidChatMessages } from "@/lib/chat-validation";
import { getApprovedDataset } from "@/lib/datasets";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const conversation = getConversation((await context.params).id);
  const dataset = conversation?.datasetId ? getApprovedDataset(conversation.datasetId) : null;
  return conversation
    ? NextResponse.json({
      conversation,
      attachedDataset: dataset ? { id: dataset.id, name: dataset.name, format: dataset.format, sizeBytes: dataset.sizeBytes } : null,
    })
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
  const body = (await request.json()) as { pinned?: unknown; datasetId?: unknown };
  const id = (await context.params).id;
  if (Object.prototype.hasOwnProperty.call(body, "datasetId")) {
    if (body.datasetId !== null && typeof body.datasetId !== "string") {
      return NextResponse.json({ error: "Dataset attachment must be an approved dataset id or null." }, { status: 400 });
    }
    if (typeof body.datasetId === "string" && !getApprovedDataset(body.datasetId)) {
      return NextResponse.json({ error: "That dataset is no longer approved." }, { status: 400 });
    }
    const conversation = setConversationDataset(id, body.datasetId as string | null);
    return conversation
      ? NextResponse.json({ conversation })
      : NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  }
  if (typeof body.pinned !== "boolean") {
    return NextResponse.json({ error: "A boolean pinned value or dataset attachment is required." }, { status: 400 });
  }
  const conversation = setConversationPinned(id, body.pinned);
  return conversation
    ? NextResponse.json({ conversation })
    : NextResponse.json({ error: "Conversation not found." }, { status: 404 });
}
