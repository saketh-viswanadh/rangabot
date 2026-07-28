import { NextResponse } from "next/server";
import { completeJsonWithOllama, streamChatWithOllama } from "@/lib/providers/ollama";
import type { ChatMessage } from "@/lib/providers/types";
import { buildKnowledgeCatalogAnswer, buildKnowledgeNewsAnswer, isKnowledgeCatalogQuestion, isKnowledgeNewsQuestion, searchKnowledge, shouldAutoSearchKnowledge } from "@/lib/knowledge";
import { formatCodeContext, isCodeContextRequest } from "@/lib/code-context";
import { getAllowedRepository } from "@/lib/repositories";
import { previewRepositoryFile } from "@/lib/repository-search";
import { buildConversationSummaryFallback, buildWordConversationPrompt, buildWordDraftPrompt, buildWordSourceTranscript, createWordArtifact, isWordConversationSummaryRequest, parseWordBriefFromPlan, parseWordDocumentPlan, parseWordDraft, shouldPlanWordDocument, validateWordDraftForBrief, type WordDocumentBrief } from "@/lib/word-documents";
import { buildRamayanaStoryCollection } from "@/lib/story-packs/ramayana";

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

async function generateStoryCollection(brief: WordDocumentBrief) {
  const isRamayana = /ramayana/i.test(`${brief.title} ${brief.purpose} ${brief.sourceNotes}`);
  if (isRamayana) {
    return buildRamayanaStoryCollection(brief);
  }
  const raw = await completeJsonWithOllama([
    { role: "system", content: "You are Rangabot's local children's author. Write complete, vivid, age-appropriate stories—not summaries, outlines, planning notes, or a report. Return valid JSON only." },
    { role: "user", content: buildWordDraftPrompt(brief) },
  ]);
  return validateWordDraftForBrief(brief, parseWordDraft(raw));
}

async function generateConversationSummary(brief: WordDocumentBrief, messages: ChatMessage[]) {
  const summaryBrief: WordDocumentBrief = { ...brief, documentType: "report", sourceNotes: buildWordSourceTranscript(messages) };
  try {
    const raw = await completeJsonWithOllama([
      { role: "system", content: "You are Rangabot's local conversation editor. Synthesize the substantive discussion into a faithful, readable summary. Omit document-creation instructions and never invent decisions. Return valid JSON only." },
      { role: "user", content: buildWordDraftPrompt(summaryBrief) },
    ]);
    return { brief: summaryBrief, draft: validateWordDraftForBrief(summaryBrief, parseWordDraft(raw)) };
  } catch {
    return { brief: summaryBrief, draft: buildConversationSummaryFallback(messages, summaryBrief) };
  }
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

    if (shouldPlanWordDocument(body.messages)) {
      const rawPlan = await completeJsonWithOllama([
        { role: "system", content: "You are Rangabot's local Word-document planner. Gather missing requirements conversationally, then produce faithful structured document content. Return valid JSON only." },
        { role: "user", content: `${buildWordConversationPrompt(body.messages)}${localCodeContext ? `\n\n${localCodeContext}` : ""}` },
      ]);
      const conversationSource = buildWordSourceTranscript(body.messages);
      const summarizesConversation = isWordConversationSummaryRequest(body.messages);
      let plan;
      try {
        const brief = parseWordBriefFromPlan(rawPlan, conversationSource);
        if (brief && summarizesConversation) {
          const summary = await generateConversationSummary(brief, body.messages);
          plan = { action: "create" as const, ...summary };
        } else if (brief?.documentType === "story-collection") {
          plan = { action: "create" as const, brief, draft: await generateStoryCollection(brief) };
        } else {
          plan = parseWordDocumentPlan(rawPlan, conversationSource);
        }
      } catch {
        const repairedPlan = await completeJsonWithOllama([
          { role: "system", content: "Repair the supplied Word-document plan into the required JSON shape. Preserve only supported facts. Return JSON only, with at least two substantive sections when action is create." },
          { role: "user", content: `Required actions are {"action":"ask","question":"..."} or {"action":"create","brief":{"title":"...","documentType":"report|proposal|meeting-notes|technical-brief|guide|article|story-collection","audience":"...","purpose":"...","tone":"professional|executive|friendly|technical|warm|playful","sourceNotes":"..."},"draft":{"subtitle":"...","executiveSummary":"...","sections":[{"heading":"...","paragraphs":["..."],"bullets":[]}],"assumptions":[]}}. Creative requests must contain finished reader-facing content, never planning notes or a report about the requested content.\n\nInvalid plan:\n${rawPlan.slice(0, 16_000)}\n\nConversation facts:\n${conversationSource.slice(-12_000)}` },
        ]);
        const repairedBrief = parseWordBriefFromPlan(repairedPlan, conversationSource);
        if (repairedBrief && summarizesConversation) {
          const summary = await generateConversationSummary(repairedBrief, body.messages);
          plan = { action: "create" as const, ...summary };
        } else if (repairedBrief?.documentType === "story-collection") {
          plan = { action: "create" as const, brief: repairedBrief, draft: await generateStoryCollection(repairedBrief) };
        } else {
          plan = parseWordDocumentPlan(repairedPlan, conversationSource);
        }
      }
      if (plan.action === "ask") {
        return new Response(plan.question, {
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Content-Type-Options": "nosniff", "X-Rangabot-Artifact-Intent": "word" },
        });
      }
      const artifact = await createWordArtifact(plan.brief, plan.draft);
      const reference = { id: artifact.id, title: artifact.title, filename: artifact.filename, previewPages: artifact.previewPages };
      return new Response(`I created **${artifact.title}** locally from our conversation. Review the rendered preview and source-grounding warning before using it.\n\n[Download the Word document](/api/artifacts/word/${artifact.id}/document)`, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "X-Content-Type-Options": "nosniff",
          "X-Rangabot-Word-Artifact": encodeURIComponent(JSON.stringify(reference)),
        },
      });
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
      const sources = await searchKnowledge(question, 5);
      const context = sources.length
        ? sources.map((source, index) => `[Source ${index + 1}: ${source.title}, passage ${source.chunk}]\n${source.content.slice(0, 1100)}`).join("\n\n")
        : "No matching passage was found in the local Knowledge Vault.";
      const history = body.messages.slice(0, -1);
      const teacherMode = body.mode === "teach";
      messages = [
        { role: "system", content: teacherMode
          ? "You are Rangabot in Teacher Mode. Teach simply, then add detail. Treat relevant local passages as the primary evidence and cite every vault-derived factual paragraph using its applicable [Source N] label. Ignore irrelevant passages instead of discussing their irrelevance. You may add stable background knowledge from your downloaded local model when the passages have gaps, but label it clearly as Local model background and never present it as source-verified or current. State material evidence gaps precisely. Distinguish historical interpretations and mythology variants."
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
