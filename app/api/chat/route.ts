import { NextResponse } from "next/server";
import { completeJsonWithOllama, completeTextWithOllama, streamChatWithOllama } from "@/lib/providers/ollama";
import type { ChatMessage } from "@/lib/providers/types";
import { buildKnowledgeCatalogAnswer, buildKnowledgeNewsAnswer, isKnowledgeCatalogQuestion, isKnowledgeNewsQuestion, searchKnowledgeWithDiagnostics, shouldAutoSearchKnowledge, type KnowledgeResult, type KnowledgeSearchMode } from "@/lib/knowledge";
import { generateGroundedTeacherAnswer } from "@/lib/knowledge-grounding";
import { buildTeacherMessages, formatKnowledgeContext } from "@/lib/teacher-mode";
import { formatCodeContext, isCodeContextRequest } from "@/lib/code-context";
import { getAllowedRepository } from "@/lib/repositories";
import { previewRepositoryFile } from "@/lib/repository-search";
import { buildConversationSummaryFallback, buildWordConversationPrompt, buildWordDraftPrompt, buildWordSourceTranscript, createWordArtifact, isWordConversationSummaryRequest, parseWordBriefFromPlan, parseWordDocumentPlan, parseWordDraft, shouldPlanWordDocument, validateWordDraftForBrief, type WordDocumentBrief } from "@/lib/word-documents";
import { findStoryPack } from "@/lib/story-packs";
import { isValidChatMessages } from "@/lib/chat-validation";
import { buildKnowledgeSearchQuery } from "@/lib/knowledge-query-planning";
import { answerDirectMemoryQuestion, directMemoryTitles, listMemories } from "@/lib/memories";
import { answerDeterministicConversationRequest, buildConversationMessagesWithSelected, buildSemanticRepairMessages, selectConversationMemories } from "@/lib/conversation-orchestration";
import { applySelectedMemoryToContract, chooseSemanticRepair, compileAnswerContract, enforceReasoningInvariants, needsBufferedConformance } from "@/lib/conversation-contract";
import { getApprovedDataset } from "@/lib/datasets";
import { inspectDatasetSchema } from "@/lib/sql-runtime";
import { buildSqlProposalMessages, parseSqlProposal, sqlProposalSchema } from "@/lib/sql-proposals";

export const runtime = "nodejs";

async function generateStoryCollection(brief: WordDocumentBrief) {
  const storyPack = findStoryPack(brief);
  if (storyPack) return storyPack.build(brief);
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
    const body = (await request.json()) as { messages?: unknown; mode?: unknown; codeContext?: unknown; datasetId?: unknown };
    if (!isValidChatMessages(body.messages)) {
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
    if (body.datasetId !== undefined && typeof body.datasetId !== "string") return NextResponse.json({ error: "The attached dataset reference is invalid." }, { status: 400 });

    const latestQuestion = [...body.messages].reverse().find((message) => message.role === "user")?.content ?? "";
    const deterministicAnswer = answerDeterministicConversationRequest(body.messages);
    if (deterministicAnswer) {
      return new Response(deterministicAnswer, {
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Rangabot-Response": "deterministic" },
      });
    }
    const directMemoryAnswer = answerDirectMemoryQuestion(latestQuestion);
    if (directMemoryAnswer) {
      const titles = directMemoryTitles(latestQuestion);
      return new Response(directMemoryAnswer, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "X-Rangabot-Memory": "direct",
          ...(titles.length ? { "X-Rangabot-Memory-Titles": encodeURIComponent(JSON.stringify(titles)) } : {}),
        },
      });
    }

    let localCodeContext: string | null = null;
    if (body.codeContext) {
      const repository = getAllowedRepository(body.codeContext.repositoryId);
      if (!repository) return NextResponse.json({ error: "That folder is no longer approved." }, { status: 400 });
      const preview = previewRepositoryFile(repository, body.codeContext.path, body.codeContext.line);
      localCodeContext = formatCodeContext(repository, preview);
    }

    if (typeof body.datasetId === "string") {
      const dataset = getApprovedDataset(body.datasetId);
      if (!dataset) return NextResponse.json({ error: "That dataset is no longer approved." }, { status: 400 });
      const columns = await inspectDatasetSchema(dataset.path);
      const raw = await completeJsonWithOllama(buildSqlProposalMessages(body.messages, dataset, columns), { signal: request.signal, jsonSchema: sqlProposalSchema, numPredict: 700 });
      const proposal = parseSqlProposal(raw);
      const reference = { datasetId: dataset.id, query: proposal.query };
      return new Response(`I drafted a read-only SQL query for **${dataset.name}**. ${proposal.explanation}\n\nReview the exact query and limits before deciding whether to run it.`, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "X-Content-Type-Options": "nosniff",
          "X-Rangabot-SQL-Proposal": encodeURIComponent(JSON.stringify(reference)),
        },
      });
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
    let knowledgeSources: KnowledgeResult[] = [];
    let knowledgeSearchMode: KnowledgeSearchMode | null = null;
    const question = latestQuestion;
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
      const history = body.messages.slice(0, -1);
      const retrievalQuery = buildKnowledgeSearchQuery(question, history);
      const { results: sources, mode: retrievalMode } = await searchKnowledgeWithDiagnostics(retrievalQuery, 5);
      knowledgeSources = sources;
      knowledgeSearchMode = retrievalMode;
      const teacherMode = body.mode === "teach";
      messages = teacherMode ? buildTeacherMessages(question, history, sources) : [
        { role: "system", content: "You are Rangabot using an automatic, entirely local Knowledge Vault lookup. Use supplied passages when they help answer the question, but ignore irrelevant passages. Cite claims drawn from them as [Source 1], [Source 2], or [Source 3]. You may use your own local-model knowledge for gaps, but clearly distinguish it from cited vault evidence and never imply that it is current or source-verified." },
        ...history,
        { role: "user", content: `QUESTION:\n${question}\n\nLOCAL KNOWLEDGE VAULT PASSAGES:\n${formatKnowledgeContext(sources)}\n\nAnswer the question using relevant passages where useful. When several sources contribute, compare and connect their ideas into one explanation rather than summarizing each passage in sequence. Preserve meaningful disagreements. Include inline citations for vault-derived claims.` },
      ];
    }

    if (localCodeContext) {
      const lastUserIndex = messages.findLastIndex((message) => message.role === "user");
      messages = messages.map((message, index) => index === lastUserIndex
        ? { role: "user", content: `${message.content}\n\n${localCodeContext}\n\nUse this code only for this answer. Mention the file and line range when relevant.` }
        : message);
    }

    const approvedMemories = listMemories();
    const selectedMemories = selectConversationMemories(approvedMemories, body.messages);
    const relevantMemory = selectedMemories.length > 0;
    const memoryTitles = relevantMemory ? buildConversationMessagesWithSelected([], selectedMemories).memoryTitles : [];
    const memoryTitleHeader = relevantMemory ? encodeURIComponent(JSON.stringify(memoryTitles)) : undefined;

    messages = buildConversationMessagesWithSelected(messages, selectedMemories, body.messages).messages;

    if (body.mode === "teach" && usesVault) {
      const grounded = await generateGroundedTeacherAnswer(messages, knowledgeSources, completeTextWithOllama);
      return new Response(grounded.answer, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "X-Content-Type-Options": "nosniff",
          "X-Rangabot-Knowledge": "used",
          "X-Rangabot-Retrieval": knowledgeSearchMode ?? "keyword-only",
          "X-Rangabot-Grounding": grounded.audit.passed ? (grounded.separated ? "separated-and-passed" : grounded.revised ? "revised-and-passed" : "passed") : "warning",
          "X-Rangabot-Code-Context": localCodeContext ? "used" : "not-used",
          "X-Rangabot-Memory": relevantMemory ? "used" : "not-used",
          ...(memoryTitleHeader ? { "X-Rangabot-Memory-Titles": memoryTitleHeader } : {}),
        },
      });
    }

    const answerContract = applySelectedMemoryToContract(compileAnswerContract(body.messages), selectedMemories);
    const responseHeaders = {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Content-Type-Options": "nosniff",
      "X-Rangabot-Knowledge": usesVault ? "used" : "not-used",
      ...(knowledgeSearchMode ? { "X-Rangabot-Retrieval": knowledgeSearchMode } : {}),
      "X-Rangabot-Code-Context": localCodeContext ? "used" : "not-used",
      "X-Rangabot-Memory": relevantMemory ? "used" : "not-used",
      ...(memoryTitleHeader ? { "X-Rangabot-Memory-Titles": memoryTitleHeader } : {}),
    };
    if (needsBufferedConformance(answerContract)) {
      let generated = await completeTextWithOllama(messages, { signal: request.signal });
      const repairMessages = buildSemanticRepairMessages(messages, generated, body.messages);
      if (repairMessages) generated = chooseSemanticRepair(generated, await completeTextWithOllama(repairMessages, { signal: request.signal }), answerContract);
      const answer = enforceReasoningInvariants(generated, answerContract);
      return new Response(answer, { headers: { ...responseHeaders, "X-Rangabot-Response": "contract-checked" } });
    }
    const stream = await streamChatWithOllama(messages, { signal: request.signal });
    return new Response(stream, {
      headers: responseHeaders,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The local model request failed." },
      { status: 500 },
    );
  }
}
