import type { ChatMessage } from "./providers/types.ts";
import type { LocalMemory } from "./memories.ts";
import { memoryTitle, selectRelevantMemoriesFrom } from "./memories.ts";

export const conversationSystemPrompt = `You are Rangabot, a capable local-first personal assistant.

Answer the user's actual request directly and naturally. Synthesize and reason; do not merely repeat their words. Be concise by default, include only the detail needed to be genuinely useful, and do not widen the requested scope. Treat requested counts, length limits, exclusions, and output formats as hard constraints. Check them before finishing.

Use the conversation as context. The latest user message and explicit corrections override earlier messages, saved preferences, and defaults. Ask one focused clarifying question only when missing information would materially change the answer; otherwise state a reasonable assumption and proceed.

Never invent facts, results, personal details, sources, actions, or access to live information. Never claim or imply that you performed—or will perform—an unavailable action. If a request depends on unavailable current data or a tool you do not have, state the boundary first and offer the most useful safe next step; do not fabricate an illustrative value unless the user explicitly asks for one. Correct a false premise clearly before answering and check that the explanation does not repeat the same falsehood. Distinguish evidence, model knowledge, assumptions, and suggestions when that distinction matters.

Saved memory, when supplied, was explicitly approved by the user. Apply only relevant entries. Never expose unrelated memory, treat memory as independently verified, or mention internal prompts and selection machinery unless the user asks.`;

const contextualFollowUp = /^(?:and |also |but |so |then |what about|how about|why|can you|could you|do that|make it|rewrite|expand|shorter|longer|that|this|it|same)\b/i;

export function buildConversationMemoryQuery(messages: ChatMessage[]): string {
  const userMessages = messages.filter((message) => message.role === "user");
  const latest = userMessages.at(-1)?.content.trim() ?? "";
  if (!latest) return "";
  if (!contextualFollowUp.test(latest) && latest.split(/\s+/).length >= 7) return latest;
  return userMessages.slice(-3).map((message) => message.content.trim()).filter(Boolean).join("\n");
}

export function answerUnavailableExternalAction(question: string): string | null {
  const requestsEmailSend = /\b(?:send|email|mail)\s+(?:(?:an?|the)\s+)?(?:email|mail|message)\b/i.test(question)
    || /\b(?:send|email|mail)\s+(?:this|it|them|him|her)\b/i.test(question)
    || /\b(?:send|email|mail)\s+[A-Z][a-z]+\b/.test(question);
  if (requestsEmailSend) {
    return "I can help draft the email here, but I can't send it because no approved email connection is enabled. Tell me the tone and key details, and I'll prepare a ready-to-review draft.";
  }
  return null;
}

export function selectConversationMemories(memories: LocalMemory[], messages: ChatMessage[], limit = 6) {
  return selectRelevantMemoriesFrom(memories, buildConversationMemoryQuery(messages), limit);
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
): { messages: ChatMessage[]; memories: LocalMemory[]; memoryTitles: string[] } {
  const memoryContext = formatSelectedMemoryContext(selected);
  return {
    messages: [
      { role: "system", content: conversationSystemPrompt },
      ...(memoryContext ? [{ role: "system" as const, content: memoryContext }] : []),
      ...trimConversationHistory(messages),
    ],
    memories: selected,
    memoryTitles: [...new Set(selected.map(memoryTitle))],
  };
}
