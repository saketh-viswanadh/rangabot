import { NextResponse } from "next/server";
import { deleteMemory, updateMemory, validateMemoryInput } from "@/lib/memories";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const body = await request.json() as { content?: unknown; kind?: unknown };
    const valid = validateMemoryInput(body.content, body.kind);
    const memory = updateMemory((await context.params).id, valid.content, valid.kind);
    return memory ? NextResponse.json({ memory }) : NextResponse.json({ error: "Memory not found." }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid memory." }, { status: 400 });
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  return deleteMemory((await context.params).id)
    ? new Response(null, { status: 204 })
    : NextResponse.json({ error: "Memory not found." }, { status: 404 });
}
