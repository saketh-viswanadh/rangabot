import { NextResponse } from "next/server";
import { createMemory, listMemories, validateMemoryInput } from "@/lib/memories";
import { profileBindingFromRequest, StaleProfileRequestError, withProfileRequest } from "@/lib/profile-request";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    profileBindingFromRequest(request);
    return NextResponse.json({ memories: listMemories() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Memories could not be read." }, { status: error instanceof StaleProfileRequestError ? 409 : 500 });
  }
}

export async function POST(request: Request) {
  try {
    return await withProfileRequest(request, { kind: "database-mutation", label: "memory creation" }, async () => {
      const body = await request.json() as { content?: unknown; kind?: unknown };
      const valid = validateMemoryInput(body.content, body.kind);
      return NextResponse.json({ memory: createMemory(valid.content, valid.kind) }, { status: 201 });
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid memory." }, { status: error instanceof StaleProfileRequestError ? 409 : 400 });
  }
}
