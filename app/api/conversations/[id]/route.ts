import { NextResponse } from "next/server";
import {
  getConversationDatabase,
  isConversationLifecycleManaged,
  setConversationDataset,
  setConversationPinned,
  updateConversation,
} from "@/lib/conversations";
import { getConversationTimeline, recoverExpiredConversationTurns } from "@/lib/conversation-turns";
import { deleteConversationWhenIdle } from "@/lib/conversation-mutation-guards";
import { isValidChatMessages } from "@/lib/chat-validation";
import { getApprovedDataset } from "@/lib/datasets";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

type DatasetBindingUpdate =
  | { kind: "updated"; conversation: NonNullable<ReturnType<typeof setConversationDataset>> }
  | { kind: "not-found" }
  | { kind: "turn-in-progress" };

function setConversationDatasetWhenIdle(id: string, datasetId: string | null): DatasetBindingUpdate {
  recoverExpiredConversationTurns();
  const database = getConversationDatabase();
  database.exec("BEGIN IMMEDIATE");
  try {
    const activeTurn = database.prepare(`
      SELECT 1 FROM conversation_turns
      WHERE conversation_id = ? AND status = 'pending'
      LIMIT 1
    `).get(id);
    if (activeTurn) {
      database.exec("ROLLBACK");
      return { kind: "turn-in-progress" };
    }

    const conversation = setConversationDataset(id, datasetId);
    database.exec("COMMIT");
    return conversation ? { kind: "updated", conversation } : { kind: "not-found" };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export async function GET(_request: Request, context: RouteContext) {
  const conversation = getConversationTimeline((await context.params).id);
  const dataset = conversation?.datasetId ? getApprovedDataset(conversation.datasetId) : null;
  return conversation
    ? NextResponse.json({
      conversation,
      attachedDataset: dataset ? { id: dataset.id, name: dataset.name, format: dataset.format, sizeBytes: dataset.sizeBytes } : null,
    })
    : NextResponse.json({ error: "Conversation not found." }, { status: 404 });
}

export async function PUT(request: Request, context: RouteContext) {
  const id = (await context.params).id;
  if (isConversationLifecycleManaged(id)) {
    return NextResponse.json({ error: "This conversation uses the server-owned turn lifecycle.", code: "lifecycle-managed" }, { status: 409 });
  }
  const body = (await request.json()) as { messages?: unknown };
  if (!isValidChatMessages(body.messages, { allowEmpty: true })) {
    return NextResponse.json({ error: "Valid messages are required." }, { status: 400 });
  }
  const conversation = updateConversation(id, body.messages);
  return conversation
    ? NextResponse.json({ conversation })
    : NextResponse.json({ error: "Conversation not found." }, { status: 404 });
}

export async function DELETE(_request: Request, context: RouteContext) {
  const result = deleteConversationWhenIdle((await context.params).id);
  if (result === "turn-in-progress") {
    return NextResponse.json({
      error: "Stop or finish the active turn before deleting this conversation.",
      code: "turn-in-progress",
    }, { status: 409 });
  }
  return result === "deleted"
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
    const update = setConversationDatasetWhenIdle(id, body.datasetId as string | null);
    if (update.kind === "turn-in-progress") {
      return NextResponse.json({
        error: "Stop or finish the active turn before changing its dataset binding.",
        code: "turn-in-progress",
      }, { status: 409 });
    }
    return update.kind === "updated"
      ? NextResponse.json({ conversation: update.conversation })
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
