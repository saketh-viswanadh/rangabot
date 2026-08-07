import { NextResponse } from "next/server";
import { completeJsonWithOllama, completeTextWithOllama, streamChatWithOllama } from "@/lib/providers/ollama";
import { ProviderError, type ChatMessage } from "@/lib/providers/types";
import { buildKnowledgeCatalogAnswer, buildKnowledgeNewsAnswer, isKnowledgeCatalogQuestion, isKnowledgeNewsQuestion, searchKnowledgeWithDiagnostics, shouldAutoSearchKnowledge, type KnowledgeResult, type KnowledgeSearchMode } from "@/lib/knowledge";
import { generateGroundedTeacherAnswer } from "@/lib/knowledge-grounding";
import { buildTeacherMessages, formatKnowledgeContext } from "@/lib/teacher-mode";
import { isCodeContextRequest } from "@/lib/code-context";
import { buildConversationSummaryFallback, buildWordConversationPrompt, buildWordDraftPrompt, buildWordSourceTranscript, createWordArtifact, isWordConversationSummaryRequest, parseWordBriefFromPlan, parseWordDocumentPlan, parseWordDraft, removeWordArtifact, shouldPlanWordDocument, validateWordDraftForBrief, type WordDocumentBrief } from "@/lib/word-documents";
import { findStoryPack } from "@/lib/story-packs";
import { isValidChatMessages } from "@/lib/chat-validation";
import { buildKnowledgeSearchQuery } from "@/lib/knowledge-query-planning";
import { listMemories } from "@/lib/memories";
import { buildConversationMessagesWithSelected, buildSemanticRepairMessages, selectConversationMemories } from "@/lib/conversation-orchestration";
import { applySelectedMemoryToContract, chooseSemanticRepair, compileAnswerContract, enforceReasoningInvariants, needsBufferedConformance } from "@/lib/conversation-contract";
import { dispatchCoreChat } from "@/lib/chat-core-dispatch";
import {
  CONVERSATION_TURN_PROTOCOL_VERSION,
  ConversationTurnError,
  cancelConversationTurn,
  claimConversationTurn,
  completeConversationTurn,
  failConversationTurn,
  isValidConversationMode,
  isValidConversationTurnId,
} from "@/lib/conversation-turns";
import { recordFailedTurnResponse, recordTurnException, responseFromCompletedAssistant, wrapSuccessfulTurnResponse, type TurnLifecycleCallbacks } from "@/lib/chat-turn-lifecycle";
import { getConversationTurnTimeoutMs } from "@/lib/local-runtime-config";

export const runtime = "nodejs";

function throwIfCancelled(error: unknown, signal?: AbortSignal) {
  if (!signal?.aborted && !(error instanceof ProviderError && error.code === "cancelled")
    && !(error instanceof DOMException && error.name === "AbortError")) return;
  throw error;
}

async function generateStoryCollection(brief: WordDocumentBrief, signal?: AbortSignal) {
  const storyPack = findStoryPack(brief);
  if (storyPack) return storyPack.build(brief);
  const raw = await completeJsonWithOllama([
    { role: "system", content: "You are Rangabot's local children's author. Write complete, vivid, age-appropriate stories—not summaries, outlines, planning notes, or a report. Return valid JSON only." },
    { role: "user", content: buildWordDraftPrompt(brief) },
  ], { signal });
  return validateWordDraftForBrief(brief, parseWordDraft(raw));
}

async function generateConversationSummary(brief: WordDocumentBrief, messages: ChatMessage[], signal?: AbortSignal) {
  const summaryBrief: WordDocumentBrief = { ...brief, documentType: "report", sourceNotes: buildWordSourceTranscript(messages) };
  try {
    const raw = await completeJsonWithOllama([
      { role: "system", content: "You are Rangabot's local conversation editor. Synthesize the substantive discussion into a faithful, readable summary. Omit document-creation instructions and never invent decisions. Return valid JSON only." },
      { role: "user", content: buildWordDraftPrompt(summaryBrief) },
    ], { signal });
    return { brief: summaryBrief, draft: validateWordDraftForBrief(summaryBrief, parseWordDraft(raw)) };
  } catch (error) {
    throwIfCancelled(error, signal);
    return { brief: summaryBrief, draft: buildConversationSummaryFallback(messages, summaryBrief) };
  }
}

type ChatGenerationInput = {
  messages: ChatMessage[];
  mode?: unknown;
  codeContext?: unknown;
  datasetId?: unknown;
  conversationId?: unknown;
};

async function generateChatResponse(body: ChatGenerationInput, signal?: AbortSignal) {
    if (body.mode === "codex") {
      return NextResponse.json(
        { error: "Codex handoff is not enabled yet. Nothing was sent to the cloud." },
        { status: 501 },
      );
    }
    if (body.codeContext !== undefined && !isCodeContextRequest(body.codeContext)) {
      return NextResponse.json({ error: "The attached code reference is invalid." }, { status: 400 });
    }
    if (body.datasetId !== undefined && (typeof body.datasetId !== "string" || body.datasetId.length < 1 || body.datasetId.length > 120 || body.datasetId !== body.datasetId.trim())) return NextResponse.json({ error: "The attached dataset reference is invalid." }, { status: 400 });
    if (body.conversationId !== undefined && (typeof body.conversationId !== "string" || body.conversationId.length < 1 || body.conversationId.length > 120)) return NextResponse.json({ error: "The conversation reference is invalid." }, { status: 400 });

    const core = await dispatchCoreChat({
      messages: body.messages,
      codeContext: body.codeContext,
      datasetId: typeof body.datasetId === "string" ? body.datasetId : undefined,
      conversationId: typeof body.conversationId === "string" ? body.conversationId : undefined,
      signal,
    });
    if (core.response) return core.response;
    const localCodeContext = core.localCodeContext;
    const latestQuestion = [...body.messages].reverse().find((message) => message.role === "user")?.content ?? "";

    if (shouldPlanWordDocument(body.messages)) {
      const rawPlan = await completeJsonWithOllama([
        { role: "system", content: "You are Rangabot's local Word-document planner. Gather missing requirements conversationally, then produce faithful structured document content. Return valid JSON only." },
        { role: "user", content: `${buildWordConversationPrompt(body.messages)}${localCodeContext ? `\n\n${localCodeContext}` : ""}` },
      ], { signal });
      const conversationSource = buildWordSourceTranscript(body.messages);
      const summarizesConversation = isWordConversationSummaryRequest(body.messages);
      let plan;
      try {
        const brief = parseWordBriefFromPlan(rawPlan, conversationSource);
        if (brief && summarizesConversation) {
          const summary = await generateConversationSummary(brief, body.messages, signal);
          plan = { action: "create" as const, ...summary };
        } else if (brief?.documentType === "story-collection") {
          plan = { action: "create" as const, brief, draft: await generateStoryCollection(brief, signal) };
        } else {
          plan = parseWordDocumentPlan(rawPlan, conversationSource);
        }
      } catch (error) {
        throwIfCancelled(error, signal);
        const repairedPlan = await completeJsonWithOllama([
          { role: "system", content: "Repair the supplied Word-document plan into the required JSON shape. Preserve only supported facts. Return JSON only, with at least two substantive sections when action is create." },
          { role: "user", content: `Required actions are {"action":"ask","question":"..."} or {"action":"create","brief":{"title":"...","documentType":"report|proposal|meeting-notes|technical-brief|guide|article|story-collection","audience":"...","purpose":"...","tone":"professional|executive|friendly|technical|warm|playful","sourceNotes":"..."},"draft":{"subtitle":"...","executiveSummary":"...","sections":[{"heading":"...","paragraphs":["..."],"bullets":[]}],"assumptions":[]}}. Creative requests must contain finished reader-facing content, never planning notes or a report about the requested content.\n\nInvalid plan:\n${rawPlan.slice(0, 16_000)}\n\nConversation facts:\n${conversationSource.slice(-12_000)}` },
        ], { signal });
        const repairedBrief = parseWordBriefFromPlan(repairedPlan, conversationSource);
        if (repairedBrief && summarizesConversation) {
          const summary = await generateConversationSummary(repairedBrief, body.messages, signal);
          plan = { action: "create" as const, ...summary };
        } else if (repairedBrief?.documentType === "story-collection") {
          plan = { action: "create" as const, brief: repairedBrief, draft: await generateStoryCollection(repairedBrief, signal) };
        } else {
          plan = parseWordDocumentPlan(repairedPlan, conversationSource);
        }
      }
      if (plan.action === "ask") {
        return new Response(plan.question, {
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Content-Type-Options": "nosniff", "X-Rangabot-Artifact-Intent": "word" },
        });
      }
      const artifact = await createWordArtifact(plan.brief, plan.draft, { signal });
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
      const { results: sources, mode: retrievalMode } = await searchKnowledgeWithDiagnostics(retrievalQuery, 5, signal);
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
      const grounded = await generateGroundedTeacherAnswer(messages, knowledgeSources, (groundingMessages) => completeTextWithOllama(groundingMessages, { signal }));
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
      let generated = await completeTextWithOllama(messages, { signal });
      const repairMessages = buildSemanticRepairMessages(messages, generated, body.messages);
      if (repairMessages) generated = chooseSemanticRepair(generated, await completeTextWithOllama(repairMessages, { signal }), answerContract);
      const answer = enforceReasoningInvariants(generated, answerContract);
      return new Response(answer, { headers: { ...responseHeaders, "X-Rangabot-Response": "contract-checked" } });
    }
    const stream = await streamChatWithOllama(messages, { signal });
    return new Response(stream, {
      headers: responseHeaders,
    });
}

type VersionedChatBody = {
  protocolVersion: typeof CONVERSATION_TURN_PROTOCOL_VERSION;
  conversationId: string;
  turnId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isVersionedChatBody(value: Record<string, unknown>): value is VersionedChatBody {
  return Object.keys(value).length === 3
    && value.protocolVersion === CONVERSATION_TURN_PROTOCOL_VERSION
    && typeof value.conversationId === "string"
    && value.conversationId.length > 0
    && value.conversationId.length <= 120
    && isValidConversationTurnId(value.turnId);
}

function turnErrorResponse(error: unknown) {
  if (!(error instanceof ConversationTurnError)) {
    return NextResponse.json({ error: "The local turn could not be processed.", code: "internal" }, { status: 500 });
  }
  const status = error.code === "not-found" ? 404
    : error.code === "conflict" || error.code === "turn-in-progress" ? 409
      : error.code === "integrity" ? 500
        : 400;
  return NextResponse.json({ error: error.message, code: error.code }, { status });
}

function providerErrorResponse(error: unknown) {
  if (error instanceof ProviderError) {
    const status = error.code === "timeout" ? 504
      : error.code === "cancelled" ? 499
        : error.code === "unavailable" || error.code === "model-missing" ? 503
          : 502;
    return NextResponse.json({ error: error.message, code: error.code }, { status });
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return NextResponse.json({ error: "Generation was stopped.", code: "cancelled" }, { status: 499 });
  }
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return NextResponse.json({ error: "The local turn exceeded its time limit.", code: "timeout" }, { status: 504 });
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "The local model request failed.", code: "internal" },
    { status: 500 },
  );
}

function lifecycleCallbacks(turnId: string): TurnLifecycleCallbacks {
  const removeUncommittedArtifact = (message: ChatMessage | null) => {
    if (!message?.wordArtifact) return message;
    removeWordArtifact(message.wordArtifact.id);
    const { wordArtifact: _artifact, ...withoutArtifact } = message;
    return withoutArtifact;
  };
  return {
    complete: (message) => { completeConversationTurn(turnId, message); },
    cancel: (partial) => { cancelConversationTurn(turnId, removeUncommittedArtifact(partial)); },
    fail: (code, message, partial) => { failConversationTurn(turnId, code, message, removeUncommittedArtifact(partial)); },
  };
}

async function handleVersionedChat(request: Request, body: VersionedChatBody) {
  let claim;
  try {
    claim = claimConversationTurn(body.conversationId, body.turnId);
  } catch (error) {
    return turnErrorResponse(error);
  }

  if (claim.kind === "completed") {
    return claim.turn.assistantMessage
      ? responseFromCompletedAssistant(claim.turn.assistantMessage)
      : NextResponse.json({ error: "The completed turn has no saved answer.", code: "integrity" }, { status: 500 });
  }
  if (claim.kind === "in-progress") {
    return NextResponse.json({
      error: "This turn is already being processed.",
      code: "turn-in-progress",
      turn: { id: claim.turn.id, status: claim.turn.status },
    }, { status: 409 });
  }
  if (claim.kind === "terminal") {
    return NextResponse.json({
      error: claim.turn.failureMessage ?? `This turn already ended as ${claim.turn.status}.`,
      code: claim.turn.failureCode ?? claim.turn.status,
      turn: { id: claim.turn.id, status: claim.turn.status },
    }, { status: 409 });
  }
  if (claim.kind !== "claimed") {
    return NextResponse.json({ error: "The local turn entered an unknown state.", code: "integrity" }, { status: 500 });
  }

  const callbacks = lifecycleCallbacks(body.turnId);
  let turnSignal: AbortSignal | undefined;
  try {
    turnSignal = AbortSignal.any([request.signal, AbortSignal.timeout(getConversationTurnTimeoutMs())]);
    if (turnSignal.aborted) throw turnSignal.reason ?? new DOMException("Stopped", "AbortError");
    const response = await generateChatResponse({
      messages: claim.messages,
      mode: claim.turn.options.mode,
      ...(claim.turn.options.codeContext ? { codeContext: claim.turn.options.codeContext } : {}),
      ...(claim.turn.options.datasetId ? { datasetId: claim.turn.options.datasetId } : {}),
      conversationId: body.conversationId,
    }, turnSignal);
    if (!response.ok) return await recordFailedTurnResponse(response, callbacks, turnSignal);
    return wrapSuccessfulTurnResponse(response, callbacks, turnSignal);
  } catch (error) {
    await recordTurnException(error, callbacks, turnSignal ?? request.signal);
    return providerErrorResponse(error);
  }
}

async function handleLegacyChat(request: Request, body: Record<string, unknown>) {
  const allowedKeys = new Set(["messages", "mode"]);
  if (!Object.keys(body).every((key) => allowedKeys.has(key))
    || !isValidChatMessages(body.messages)
    || body.messages.some((message) => message.role === "system")
    || (body.mode !== undefined && !isValidConversationMode(body.mode))) {
    return NextResponse.json({
      error: "Legacy chat accepts only stateless user and assistant messages. Start a versioned turn for saved conversations.",
      code: "invalid-request",
    }, { status: 400 });
  }
  try {
    return await generateChatResponse({ messages: body.messages, mode: body.mode }, request.signal);
  } catch (error) {
    return providerErrorResponse(error);
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "A valid JSON chat request is required.", code: "invalid-request" }, { status: 400 });
  }
  if (!isRecord(body)) {
    return NextResponse.json({ error: "A valid chat request is required.", code: "invalid-request" }, { status: 400 });
  }
  if ("protocolVersion" in body || "conversationId" in body || "turnId" in body) {
    return isVersionedChatBody(body)
      ? handleVersionedChat(request, body)
      : NextResponse.json({ error: "A valid versioned conversation turn is required.", code: "invalid-request" }, { status: 400 });
  }
  return handleLegacyChat(request, body);
}
