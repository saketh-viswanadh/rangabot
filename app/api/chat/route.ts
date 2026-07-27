import { NextResponse } from "next/server";
import { chatWithOllama } from "@/lib/providers/ollama";
import type { ChatMessage } from "@/lib/providers/types";

export const runtime = "nodejs";

function validMessages(value: unknown): value is ChatMessage[] {
  return Array.isArray(value) && value.length > 0 && value.every((message) => {
    if (!message || typeof message !== "object") return false;
    const candidate = message as Partial<ChatMessage>;
    return ["user", "assistant", "system"].includes(candidate.role ?? "")
      && typeof candidate.content === "string"
      && candidate.content.trim().length > 0
      && candidate.content.length <= 50_000;
  });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { messages?: unknown; mode?: unknown };
    if (!validMessages(body.messages)) {
      return NextResponse.json({ error: "A valid message is required." }, { status: 400 });
    }
    if (body.mode === "codex") {
      return NextResponse.json(
        { error: "Codex handoff is not enabled yet. Nothing was sent to the cloud." },
        { status: 501 },
      );
    }

    const content = await chatWithOllama(body.messages);
    return NextResponse.json({ content, source: "local" });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The local model request failed." },
      { status: 500 },
    );
  }
}
