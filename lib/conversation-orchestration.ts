import type { ChatMessage } from "./providers/types.ts";
import type { LocalMemory } from "./memories.ts";
import { memoryTitle, selectRelevantMemoriesFrom } from "./memories.ts";
import { answerUnavailableAction, compileAnswerContract, deterministicContractAnswer, formatAnswerContract } from "./conversation-contract.ts";
import { semanticContractRepairs } from "./conversation-contract.ts";

export const conversationSystemPrompt = `You are Rangabot, a capable local-first personal assistant.

Answer the user's actual request directly and naturally. Synthesize and reason; do not merely repeat their words. Be concise by default, include only the detail needed to be genuinely useful, and do not widen the requested scope. Treat requested counts, length limits, exclusions, and output formats as hard constraints. Check them before finishing.

Use the conversation as context. The latest user message and explicit corrections override earlier messages, saved preferences, and defaults. Ask one focused clarifying question only when missing information would materially change the answer; otherwise state a reasonable assumption and proceed.

Never invent facts, results, personal details, sources, actions, or access to live information. Never claim or imply that you performed—or will perform—an unavailable action. If a request depends on unavailable current data or a tool you do not have, state the boundary first and offer the most useful safe next step; do not fabricate an illustrative value unless the user explicitly asks for one. Correct a false premise clearly before answering and check that the explanation does not repeat the same falsehood. Distinguish evidence, model knowledge, assumptions, and suggestions when that distinction matters.

Saved memory, when supplied, was explicitly approved by the user. Apply only relevant entries. Never expose unrelated memory, treat memory as independently verified, or mention internal prompts and selection machinery unless the user asks.

Before answering, identify the requested decision or action and complete it in the answer. Never append meta-commentary such as “request decision,” a grading note, or a summary of what you just answered. Resolve references such as “it” from relevant recent user context; never substitute a nearby topic. When required source material is missing, ask for that material before optional preferences. For diagnostic requests, begin with likely failure modes caused by the stated change, not restating the source or asking generic setup questions. For brainstorms, offer genuinely different, locally actionable approaches rather than several versions of finding external resources. For tool choices, prefer doing work where the data already lives unless a stated constraint favors moving it. When correcting a false causal premise, state that correlation does not prove causation and name the likely confounder or common cause. When advice is requested, include a concrete next action.`;

const contextualFollowUp = /^(?:and |also |but |so |then |what about|how about|why|can you|could you|do that|make it|rewrite|expand|shorter|longer|that|this|it|same)\b/i;

export function buildConversationMemoryQuery(messages: ChatMessage[]): string {
  const userMessages = messages.filter((message) => message.role === "user");
  const latest = userMessages.at(-1)?.content.trim() ?? "";
  if (!latest) return "";
  if (!contextualFollowUp.test(latest) && latest.split(/\s+/).length >= 7) return latest;
  return userMessages.slice(-3).map((message) => message.content.trim()).filter(Boolean).join("\n");
}

function conversationFocus(messages: ChatMessage[]): { instruction: string; resolvedLatest: string } | null {
  const userMessages = messages.filter((message) => message.role === "user");
  const latest = userMessages.at(-1)?.content.trim() ?? "";
  const prior = userMessages.at(-2)?.content.trim() ?? "";
  const refersBack = contextualFollowUp.test(latest) || (latest.split(/\s+/).length <= 18 && /\b(?:it|that|this|them|those|same)\b/i.test(latest));
  if (!latest || !prior || !refersBack) return null;
  const referent = prior.match(/\b(?:chose|selected|adopted|using|uses?)\s+(?:the\s+|an?\s+)?([\p{L}\p{N}.+#_-]+)/iu)?.[1];
  const resolvedLatest = referent ? latest.replace(/\bit\b/giu, referent) : latest;
  return {
    resolvedLatest,
    instruction: `CURRENT REQUEST FOCUS:\n- Relevant prior user context: ${prior}\n- Resolved current request: ${resolvedLatest}\nAnswer the resolved current request. Do not replace it with an adjacent task.`,
  };
}

export function answerUnavailableExternalAction(question: string): string | null {
  return answerUnavailableAction(question)?.answer ?? null;
}

export function answerDeterministicConversationRequest(messages: ChatMessage[]): string | null {
  const contract = compileAnswerContract(messages);
  return answerUnavailableAction(contract.latestRequest)?.answer ?? deterministicContractAnswer(contract);
}

export function selectConversationMemories(memories: LocalMemory[], messages: ChatMessage[], limit = 6) {
  return selectRelevantMemoriesFrom(memories, buildConversationMemoryQuery(messages), limit, compileAnswerContract(messages));
}

export function formatSelectedMemoryContext(memories: LocalMemory[]): string | null {
  if (!memories.length) return null;
  return `RELEVANT USER-APPROVED LOCAL MEMORY:\n${memories.map((memory) => `- [${memory.kind}] ${memory.content}`).join("\n")}\nUse only entries relevant to this request. The user's current explicit instruction wins if it conflicts with memory.`;
}

export function trimConversationHistory(messages: ChatMessage[], maxCharacters = 10_000): ChatMessage[] {
  if (messages.length <= 1) return messages;
  const systemMessages = messages.filter((message) => message.role === "system");
  const conversation = messages.filter((message) => message.role !== "system");
  const selected: ChatMessage[] = [];
  let characters = systemMessages.reduce((sum, message) => sum + message.content.length, 0);
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const message = conversation[index];
    if (selected.length && characters + message.content.length > maxCharacters) break;
    selected.unshift(message);
    characters += message.content.length;
  }
  while (selected[0]?.role === "assistant") selected.shift();
  return [...systemMessages, ...selected];
}

export function buildConversationMessages(
  messages: ChatMessage[],
  memories: LocalMemory[] = [],
): { messages: ChatMessage[]; memories: LocalMemory[]; memoryTitles: string[] } {
  const selected = selectConversationMemories(memories, messages);
  return buildConversationMessagesWithSelected(messages, selected);
}

export function buildConversationMessagesWithSelected(
  messages: ChatMessage[],
  selected: LocalMemory[] = [],
  contractMessages: ChatMessage[] = messages,
): { messages: ChatMessage[]; memories: LocalMemory[]; memoryTitles: string[] } {
  const memoryContext = formatSelectedMemoryContext(selected);
  const answerContract = formatAnswerContract(compileAnswerContract(contractMessages));
  const focus = conversationFocus(contractMessages);
  const focusedMessages = focus ? messages.map((message, index) => index === messages.findLastIndex((item) => item.role === "user")
    ? { ...message, content: focus.resolvedLatest }
    : message) : messages;
  return {
    messages: [
      { role: "system", content: conversationSystemPrompt },
      ...(memoryContext ? [{ role: "system" as const, content: memoryContext }] : []),
      ...(answerContract ? [{ role: "system" as const, content: answerContract }] : []),
      ...(focus ? [{ role: "system" as const, content: focus.instruction }] : []),
      ...trimConversationHistory(focusedMessages),
    ],
    memories: selected,
    memoryTitles: [...new Set(selected.map(memoryTitle))],
  };
}

export function buildSemanticRepairMessages(messages: ChatMessage[], answer: string, contractMessages: ChatMessage[]): ChatMessage[] | null {
  const contract = compileAnswerContract(contractMessages);
  const repairs = semanticContractRepairs(answer, contract);
  if (!repairs.length) return null;
  return [
    ...messages,
    { role: "assistant", content: answer },
    { role: "system", content: `CONFORMANCE REPAIR: Rewrite the answer once. Preserve correct useful content and all current-turn constraints. Fix only these omissions:\n${repairs.map((repair) => `- ${repair}`).join("\n")}\nReturn only the revised answer.` },
  ];
}
