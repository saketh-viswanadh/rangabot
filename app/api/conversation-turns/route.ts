import { NextResponse } from "next/server";
import { isCodeContextRequest } from "@/lib/code-context";
import {
  CONVERSATION_TURN_PROTOCOL_VERSION,
  ConversationTurnError,
  beginConversationTurn,
  cancelConversationTurn,
  isValidConversationMode,
  isValidConversationTurnId,
  isValidTurnUserMessage,
} from "@/lib/conversation-turns";
import { getApprovedDataset } from "@/lib/datasets";

export const runtime = "nodejs";

function errorResponse(error: unknown) {
  if (!(error instanceof ConversationTurnError)) {
    return NextResponse.json({ error: "The local turn could not be started.", code: "internal" }, { status: 500 });
  }
  const status = error.code === "not-found" ? 404
    : error.code === "conflict" || error.code === "turn-in-progress" ? 409
      : error.code === "integrity" ? 500
        : 400;
  return NextResponse.json({ error: error.message, code: error.code }, { status });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (!Object.keys(body).every((key) => ["protocolVersion", "turnId", "conversationId", "projectId", "datasetId", "message", "options"].includes(key))
      || body.protocolVersion !== CONVERSATION_TURN_PROTOCOL_VERSION
      || !isValidConversationTurnId(body.turnId)
      || !isValidTurnUserMessage(body.message)
      || (body.conversationId !== undefined && (typeof body.conversationId !== "string" || !body.conversationId || body.conversationId.length > 120))
      || (body.projectId !== undefined && body.projectId !== null && (typeof body.projectId !== "string" || !body.projectId || body.projectId.length > 120))
      || (body.datasetId !== undefined && body.datasetId !== null && (typeof body.datasetId !== "string" || !body.datasetId || body.datasetId.length > 120))
      || !body.options || typeof body.options !== "object" || Array.isArray(body.options)) {
      return NextResponse.json({ error: "A valid versioned local turn is required.", code: "invalid" }, { status: 400 });
    }
    const options = body.options as Record<string, unknown>;
    if (!Object.keys(options).every((key) => key === "mode" || key === "codeContext")
      || !isValidConversationMode(options.mode)
      || (options.codeContext !== undefined && !isCodeContextRequest(options.codeContext))) {
      return NextResponse.json({ error: "The local turn options are invalid.", code: "invalid" }, { status: 400 });
    }
    if (body.conversationId !== undefined && (body.projectId !== undefined || body.datasetId !== undefined)) {
      return NextResponse.json({ error: "Existing conversations own their saved project and dataset bindings.", code: "invalid" }, { status: 400 });
    }
    if (typeof body.datasetId === "string" && !getApprovedDataset(body.datasetId)) {
      return NextResponse.json({ error: "That dataset is no longer approved.", code: "invalid" }, { status: 400 });
    }
    const result = beginConversationTurn({
      id: body.turnId,
      ...(typeof body.conversationId === "string" ? { conversationId: body.conversationId } : {}),
      ...(body.projectId === null || typeof body.projectId === "string" ? { projectId: body.projectId } : {}),
      ...(body.datasetId === null || typeof body.datasetId === "string" ? { datasetId: body.datasetId } : {}),
      userMessage: body.message,
      options: {
        mode: options.mode,
        ...(options.codeContext ? { codeContext: options.codeContext } : {}),
      },
    });
    if (request.signal.aborted) {
      if (!result.replayed) cancelConversationTurn(result.turn.id);
      return NextResponse.json({ error: "Turn creation was stopped.", code: "cancelled" }, { status: 499 });
    }
    return NextResponse.json({
      conversationId: result.conversationId,
      turn: { id: result.turn.id, status: result.turn.status, replayed: result.replayed },
    }, { status: result.replayed ? 200 : 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
