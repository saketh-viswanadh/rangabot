import { NextResponse } from "next/server";
import { streamChatWithOllama } from "@/lib/providers/ollama";
import type { ChatMessage } from "@/lib/providers/types";
import { buildKnowledgeCatalogAnswer, isKnowledgeCatalogQuestion, searchKnowledge } from "@/lib/knowledge";

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

    let messages = body.messages;
    if (body.mode === "teach") {
      const question = [...body.messages].reverse().find((message) => message.role === "user")?.content ?? "";
      if (isKnowledgeCatalogQuestion(question)) {
        return new Response(buildKnowledgeCatalogAnswer(), {
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Content-Type-Options": "nosniff" },
        });
      }
      const sources = await searchKnowledge(question, 3);
      const context = sources.length
        ? sources.map((source, index) => `[Source ${index + 1}: ${source.title}, passage ${source.chunk}]\n${source.content.slice(0, 900)}`).join("\n\n")
        : "No matching passage was found in the local Knowledge Vault.";
      const history = body.messages.slice(0, -1);
      messages = [
        { role: "system", content: "You are Rangabot in Teacher Mode. Use only the supplied local passages for factual claims. Teach simply, then add detail. Cite every factual paragraph as [Source 1], [Source 2], or [Source 3]. Never claim that the local vault is unavailable when passages are supplied. If the passages are insufficient, state exactly what is missing. Distinguish historical interpretations and mythology variants." },
        ...history,
        { role: "user", content: `QUESTION:\n${question}\n\nLOCAL KNOWLEDGE VAULT PASSAGES:\n${context}\n\nAnswer the question from these passages and include inline source citations.` },
      ];
    }

    const stream = await streamChatWithOllama(messages);
    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The local model request failed." },
      { status: 500 },
    );
  }
}
