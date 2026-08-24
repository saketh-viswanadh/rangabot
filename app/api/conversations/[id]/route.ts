import { NextResponse } from "next/server";
import {
  getConversation,
  getConversationDatabase,
  setConversationPinned,
} from "@/lib/conversations";
import {
  conversationContextBinding,
  getConversationTimeline,
  isValidConversationContextBinding,
  type ConversationContextBinding,
} from "@/lib/conversation-turns";
import {
  deleteConversationWhenIdle,
  setConversationDatasetWhenIdle,
  setConversationProjectWhenIdle,
} from "@/lib/conversation-mutation-guards";
import { getApprovedDataset } from "@/lib/datasets";
import { listConversationResponseFeedback } from "@/lib/response-feedback";
import { profileBindingFromRequest, StaleProfileRequestError, withProfileRequest } from "@/lib/profile-request";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const id = (await context.params).id;
    profileBindingFromRequest(request);
    const canonicalConversation = getConversation(id);
    const conversation = canonicalConversation ? getConversationTimeline(id) : null;
    const dataset = canonicalConversation?.datasetId ? getApprovedDataset(canonicalConversation.datasetId) : null;
    return conversation && canonicalConversation
      ? NextResponse.json({
        conversation,
        attachedDataset: dataset ? { id: dataset.id, name: dataset.name, format: dataset.format, sizeBytes: dataset.sizeBytes } : null,
        conversationBinding: conversationContextBinding(canonicalConversation),
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
      const body = (await request.json()) as { pinned?: unknown; datasetId?: unknown; projectId?: unknown; expectedConversationBinding?: unknown };
      const id = (await context.params).id;
      if (Object.prototype.hasOwnProperty.call(body, "projectId")) {
        if (body.projectId !== null && typeof body.projectId !== "string") {
          return NextResponse.json({ error: "Project must be an existing project id or All chats." }, { status: 400 });
        }
        if (!isValidConversationContextBinding(body.expectedConversationBinding)) {
          return NextResponse.json({ error: "Reload this chat before changing its project binding.", code: "invalid-binding" }, { status: 400 });
        }
        const update = setConversationProjectWhenIdle(id, body.projectId as string | null, body.expectedConversationBinding as ConversationContextBinding);
        if (update.kind === "stale-binding") {
          return NextResponse.json({
            error: "This chat changed in another local window. Nothing was updated; reopen it before trying again.",
            code: "stale-binding",
          }, { status: 409 });
        }
        if (update.kind === "turn-in-progress") {
          return NextResponse.json({
            error: "Stop or finish the active turn before changing its project binding.",
            code: "turn-in-progress",
          }, { status: 409 });
        }
        if (update.kind !== "updated") return NextResponse.json({ error: "Conversation or project not found." }, { status: 404 });
        const canonicalConversation = getConversation(id);
        return canonicalConversation
          ? NextResponse.json({ conversation: update.conversation, conversationBinding: conversationContextBinding(canonicalConversation) })
          : NextResponse.json({ error: "Conversation not found." }, { status: 404 });
      }
      if (Object.prototype.hasOwnProperty.call(body, "datasetId")) {
        if (body.datasetId !== null && typeof body.datasetId !== "string") {
          return NextResponse.json({ error: "Dataset attachment must be an approved dataset id or null." }, { status: 400 });
        }
        if (typeof body.datasetId === "string" && !getApprovedDataset(body.datasetId)) {
          return NextResponse.json({ error: "That dataset is no longer approved." }, { status: 400 });
        }
        if (!isValidConversationContextBinding(body.expectedConversationBinding)) {
          return NextResponse.json({ error: "Reload this chat before changing its dataset binding.", code: "invalid-binding" }, { status: 400 });
        }
        const update = setConversationDatasetWhenIdle(id, body.datasetId as string | null, body.expectedConversationBinding as ConversationContextBinding);
        if (update.kind === "stale-binding") {
          return NextResponse.json({
            error: "This chat changed in another local window. Nothing was updated; reopen it before trying again.",
            code: "stale-binding",
          }, { status: 409 });
        }
        if (update.kind === "turn-in-progress") {
          return NextResponse.json({
            error: "Stop or finish the active turn before changing its dataset binding.",
            code: "turn-in-progress",
          }, { status: 409 });
        }
        if (update.kind !== "updated") return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
        const canonicalConversation = getConversation(id);
        return canonicalConversation
          ? NextResponse.json({ conversation: update.conversation, conversationBinding: conversationContextBinding(canonicalConversation) })
          : NextResponse.json({ error: "Conversation not found." }, { status: 404 });
      }
      if (typeof body.pinned !== "boolean") {
        return NextResponse.json({ error: "A pin, project, or dataset update is required." }, { status: 400 });
      }
      const conversation = setConversationPinned(id, body.pinned);
      const canonicalConversation = conversation ? getConversation(id) : null;
      return conversation && canonicalConversation
        ? NextResponse.json({ conversation, conversationBinding: conversationContextBinding(canonicalConversation) })
        : NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The conversation was not updated." }, { status: error instanceof StaleProfileRequestError ? 409 : 500 });
  }
}
