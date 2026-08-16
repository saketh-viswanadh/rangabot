import { NextResponse } from "next/server";
import { deleteMemory, updateMemory, validateMemoryInput } from "@/lib/memories";
import { StaleProfileRequestError, withProfileRequest } from "@/lib/profile-request";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    return await withProfileRequest(request, { kind: "database-mutation", label: "memory update" }, async () => {
      const body = await request.json() as { content?: unknown; kind?: unknown };
      const valid = validateMemoryInput(body.content, body.kind);
      const memory = updateMemory((await context.params).id, valid.content, valid.kind);
      return memory ? NextResponse.json({ memory }) : NextResponse.json({ error: "Memory not found." }, { status: 404 });
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid memory." }, { status: error instanceof StaleProfileRequestError ? 409 : 400 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    return await withProfileRequest(request, { kind: "database-mutation", label: "memory deletion" }, async () => (
      deleteMemory((await context.params).id)
        ? new Response(null, { status: 204 })
        : NextResponse.json({ error: "Memory not found." }, { status: 404 })
    ));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Memory was not deleted." }, { status: error instanceof StaleProfileRequestError ? 409 : 400 });
  }
}
