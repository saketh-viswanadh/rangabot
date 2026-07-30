import { NextResponse } from "next/server";
import { createMemory, listMemories, validateMemoryInput } from "@/lib/memories";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ memories: listMemories() });
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { content?: unknown; kind?: unknown };
    const valid = validateMemoryInput(body.content, body.kind);
    return NextResponse.json({ memory: createMemory(valid.content, valid.kind) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid memory." }, { status: 400 });
  }
}
