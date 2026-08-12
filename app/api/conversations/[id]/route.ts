import { NextResponse } from "next/server";
import {
  getConversationDatabase,
  setConversationDataset,
  setConversationPinned,
} from "@/lib/conversations";
import { getConversationTimeline, recoverExpiredConversationTurns } from "@/lib/conversation-turns";
import { deleteConversationWhenIdle } from "@/lib/conversation-mutation-guards";
import { getApprovedDataset } from "@/lib/datasets";
import { listConversationResponseFeedback } from "@/lib/response-feedback";
import { profileBindingFromRequest, StaleProfileRequestError, withProfileRequest } from "@/lib/profile-request";

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

export async function GET(request: Request, context: RouteContext) {
  try {
    const id = (await context.params).id;
    profileBindingFromRequest(request);
    const conversation = getConversationTimeline(id);
    const dataset = conversation?.datasetId ? getApprovedDataset(conversation.datasetId) : null;
    return conversation
      ? NextResponse.json({
        conversation,
        attachedDataset: dataset ? { id: dataset.id, name: dataset.name, format: dataset.format, sizeBytes: dataset.sizeBytes } : null,
        responseFeedback: listConversationResponseFeedback(getConversationDatabase(), conversation.id),
      })
      : NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The conversation could not be read." }, { status: error instanceof StaleProfileRequestError ? 409 : 500 });
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    return await withProfileRequest(request, { kind: "database-mutation", label: "conversation deletion" }, async () => {
      const result = deleteConversationWhenIdle((await context.params).id);
      if (result === "turn-in-progress") {
        return NextResponse.json({
          error: "Stop or finish the active turn before deleting this conversation.",
          code: "turn-in-progress",
        }, { status: 409 });
      }
      if (result === "artifact-cleanup-failed") {
        return NextResponse.json({
          error: "This conversation was not deleted because one or more of its local Word artifacts could not be removed. Check local file permissions, then try again.",
          code: "artifact-cleanup-failed",
          retriable: true,
        }, { status: 503 });
      }
      if (result === "deleted-cleanup-pending") {
        return NextResponse.json({
          warning: "The conversation was deleted, but its private artifact quarantine could not be fully purged. Restart Rangabot to retry cleanup safely.",
          code: "deleted-cleanup-pending",
          retriableOnRestart: true,
        }, { status: 202 });
      }
      return result === "deleted"
        ? new Response(null, { status: 204 })
        : NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The conversation was not deleted." }, { status: error instanceof StaleProfileRequestError ? 409 : 500 });
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    return await withProfileRequest(request, { kind: "database-mutation", label: "conversation update" }, async () => {
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
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The conversation was not updated." }, { status: error instanceof StaleProfileRequestError ? 409 : 500 });
  }
}
