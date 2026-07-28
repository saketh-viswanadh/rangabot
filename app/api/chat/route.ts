import { NextResponse } from "next/server";
import { streamChatWithOllama } from "@/lib/providers/ollama";
import type { ChatMessage } from "@/lib/providers/types";
import { buildKnowledgeCatalogAnswer, buildKnowledgeNewsAnswer, isKnowledgeCatalogQuestion, isKnowledgeNewsQuestion, searchKnowledge, shouldAutoSearchKnowledge } from "@/lib/knowledge";
import { formatCodeContext, isCodeContextRequest } from "@/lib/code-context";
import { getAllowedRepository } from "@/lib/repositories";
import { previewRepositoryFile } from "@/lib/repository-search";

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
    const body = (await request.json()) as { messages?: unknown; mode?: unknown; codeContext?: unknown };
    if (!validMessages(body.messages)) {
      return NextResponse.json({ error: "A valid message is required." }, { status: 400 });
    }
    if (body.mode === "codex") {
      return NextResponse.json(
        { error: "Codex handoff is not enabled yet. Nothing was sent to the cloud." },
        { status: 501 },
      );
    }
    if (body.codeContext !== undefined && !isCodeContextRequest(body.codeContext)) {
      return NextResponse.json({ error: "The attached code reference is invalid." }, { status: 400 });
    }

    let localCodeContext: string | null = null;
    if (body.codeContext) {
      const repository = getAllowedRepository(body.codeContext.repositoryId);
      if (!repository) return NextResponse.json({ error: "That folder is no longer approved." }, { status: 400 });
      const preview = previewRepositoryFile(repository, body.codeContext.path, body.codeContext.line);
      localCodeContext = formatCodeContext(repository, preview);
    }

    let messages = body.messages;
    const question = [...body.messages].reverse().find((message) => message.role === "user")?.content ?? "";
    const usesVault = body.mode === "teach" || (body.mode === "smart" && shouldAutoSearchKnowledge(question));
    if (usesVault) {
      if (!localCodeContext && isKnowledgeCatalogQuestion(question)) {
        return new Response(buildKnowledgeCatalogAnswer(), {
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Content-Type-Options": "nosniff", "X-Rangabot-Knowledge": "used" },
        });
      }
      if (!localCodeContext && isKnowledgeNewsQuestion(question)) {
        return new Response(buildKnowledgeNewsAnswer(question), {
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Content-Type-Options": "nosniff", "X-Rangabot-Knowledge": "used" },
        });
      }
      const sources = await searchKnowledge(question, 3);
      const context = sources.length
        ? sources.map((source, index) => `[Source ${index + 1}: ${source.title}, passage ${source.chunk}]\n${source.content.slice(0, 900)}`).join("\n\n")
        : "No matching passage was found in the local Knowledge Vault.";
      const history = body.messages.slice(0, -1);
      const teacherMode = body.mode === "teach";
      messages = [
        { role: "system", content: teacherMode
          ? "You are Rangabot in Teacher Mode. Use only the supplied local passages for factual claims. Teach simply, then add detail. Cite every factual paragraph as [Source 1], [Source 2], or [Source 3]. Never claim that the local vault is unavailable when passages are supplied. If the passages are insufficient, state exactly what is missing. Distinguish historical interpretations and mythology variants."
          : "You are Rangabot using an automatic, entirely local Knowledge Vault lookup. Use supplied passages when they help answer the question, but ignore irrelevant passages. Cite claims drawn from them as [Source 1], [Source 2], or [Source 3]. You may use your own local-model knowledge for gaps, but clearly distinguish it from cited vault evidence and never imply that it is current or source-verified." },
        ...history,
        { role: "user", content: `QUESTION:\n${question}\n\nLOCAL KNOWLEDGE VAULT PASSAGES:\n${context}\n\nAnswer the question${teacherMode ? " from these passages" : " using relevant passages where useful"} and include inline citations for vault-derived claims.` },
      ];
    }

    if (localCodeContext) {
      const lastUserIndex = messages.findLastIndex((message) => message.role === "user");
      messages = messages.map((message, index) => index === lastUserIndex
        ? { role: "user", content: `${message.content}\n\n${localCodeContext}\n\nUse this code only for this answer. Mention the file and line range when relevant.` }
        : message);
    }

    const stream = await streamChatWithOllama(messages);
    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Content-Type-Options": "nosniff",
        "X-Rangabot-Knowledge": usesVault ? "used" : "not-used",
        "X-Rangabot-Code-Context": localCodeContext ? "used" : "not-used",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The local model request failed." },
      { status: 500 },
    );
  }
}
