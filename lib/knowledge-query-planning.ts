import type { ChatMessage } from "./providers/types";

const contextualReference = /^(?:and|but|so|then|what about|how about)\b|\b(?:it|its|that|those|they|them|this|these|former|latter)\b/i;

function compactForSearch(content: string) {
  return content
    .replace(/^\[Replying to [^\]]+\]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

export function buildKnowledgeSearchQuery(question: string, history: ChatMessage[]) {
  const normalizedQuestion = compactForSearch(question);
  if (!contextualReference.test(normalizedQuestion)) return normalizedQuestion;

  const priorUserContext = [...history]
    .reverse()
    .filter((message) => message.role === "user")
    .map((message) => compactForSearch(message.content))
    .find((content) => content.length >= 8);

  return priorUserContext ? `${priorUserContext}\n${normalizedQuestion}` : normalizedQuestion;
}
