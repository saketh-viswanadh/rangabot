import type { ChatMessage } from "./providers/types.ts";

export type ListConstraint = { count: number; style: "numbered" | "bullets" | "outline" };
export type AnswerContract = {
  latestRequest: string;
  maxWords?: number;
  exactWords?: number;
  sentenceCount?: number;
  list?: ListConstraint;
  noIntroduction: boolean;
  noClosing: boolean;
  noBullets: boolean;
  exactLiteral?: string;
  forbiddenTerms: string[];
  currentLanguage?: string;
  currentTone?: string;
  allowedLiterals?: string[];
  commaSeparatedOnly: boolean;
  lowercaseWords: boolean;
  outlineOnly: boolean;
  falseCausalPremise: boolean;
  missingSourceMaterial: boolean;
  requiredSubject?: string;
};

const numberWords: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

function count(value: string | undefined) {
  if (!value) return undefined;
  return /^\d+$/.test(value) ? Number(value) : numberWords[value.toLowerCase()];
}

export function latestUserRequest(messages: ChatMessage[]) {
  return [...messages].reverse().find((message) => message.role === "user")?.content.trim() ?? "";
}

export function compileAnswerContract(messages: ChatMessage[]): AnswerContract {
  const latestRequest = latestUserRequest(messages);
  const lower = latestRequest.toLowerCase();
  const explicitMaxWords = count(lower.match(/(?:at most|under|in under|no more than|maximum of)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+words?/)?.[1]);
  const qualitativeMax = /\bone\s+(?:warm[, ]+)?practical\s+(?:thing|suggestion)\b|\bone short analogy\b/.test(lower) ? 90
    : /\bsingle most useful next question\b/.test(lower) ? 35
      : /\b(?:concisely|concise)\b/.test(lower) ? 100
        : /\b(?:briefly|be brief|brief answer|short answer)\b/.test(lower) ? 35 : undefined;
  const requestedSentenceCount = count(lower.match(/(?:exactly\s+|(?:write|give)(?:\s+me)?\s+)(\d+|one|two|three|four|five|six|seven|eight|nine|ten)(?:\s+\w+){0,2}\s+sentences?/)?.[1]);
  const exactWords = count(lower.match(/exactly\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:lowercase\s+)?words?/)?.[1]);
  const sentenceCount = requestedSentenceCount ?? (/\bsingle most useful next question\b/.test(lower) ? 1 : undefined);
  const listMatch = lower.match(/(?:exactly\s+|only\s+(?:a\s+)?|first\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten)(?:-item|\s+item)?\s+(markdown\s+bullets?|bullets?|numbered(?:\s+list)?|outline|checks?)/);
  const listCount = count(listMatch?.[1]);
  const listStyle = listMatch?.[2]?.includes("bullet") ? "bullets" : listMatch?.[2]?.includes("outline") ? "outline" : listMatch ? "numbered" : undefined;
  const inferredListBudget = listCount && listCount <= 5 && listStyle !== "outline" ? listCount * 25 : undefined;
  const maxWords = explicitMaxWords ?? qualitativeMax ?? (sentenceCount === 1 ? 35 : inferredListBudget);
  const exactLiteral = latestRequest.match(/(?:reply|respond|answer)(?:\s+with)?\s+exactly\s+one\s+word\s*:\s*([\p{L}\p{N}_-]+)[.!?]*$/iu)?.[1];
  const forbiddenTerms = [...latestRequest.matchAll(/(?:do not|don't)\s+(?:use|include|mention)\s+(?:the\s+word\s+)?["']?([\p{L}\p{N}_-]+)["']?/giu)].map((match) => match[1]);
  const currentLanguage = lower.match(/\buse\s+(python|sql|javascript|typescript|pyspark|r|java)\b/)?.[1];
  const currentTone = lower.match(/\b(sober|formal|friendly|playful|professional|technical|warm|concise|brief)\b/)?.[1];
  const choiceMatch = latestRequest.match(/(?:answer|reply)(?:\s+with)?\s+only\s+([\p{L}\p{N}_-]+)\s+or\s+([\p{L}\p{N}_-]+)\s*:/iu);
  const requiredSubject = lower.match(/\bexplain\s+(?:the\s+)?(.+?)(?:\s+to\b|\s+for\b|\s+in\b|[,.?:]|$)/)?.[1]?.trim();
  const falseCausalPremise = /\b(?:correlation|association)\b[\s\S]{0,40}\b(?:proves?|means?|causes?|implies?)\b[\s\S]{0,20}\bcaus/.test(lower);
  return {
    latestRequest,
    ...(maxWords ? { maxWords } : {}),
    ...(exactWords ? { exactWords } : {}),
    ...(sentenceCount ? { sentenceCount } : {}),
    ...(listCount && listStyle ? { list: { count: listCount, style: listStyle } } : {}),
    noIntroduction: /\bno (?:introduction|intro)\b/.test(lower),
    noClosing: /\bno (?:closing|conclusion|closing sentence)\b/.test(lower),
    noBullets: /\b(?:no|without) bullets?\b/.test(lower),
    ...(exactLiteral ? { exactLiteral } : {}),
    forbiddenTerms,
    ...(currentLanguage ? { currentLanguage } : {}),
    ...(currentTone ? { currentTone } : {}),
    ...(choiceMatch ? { allowedLiterals: [choiceMatch[1], choiceMatch[2]] } : {}),
    commaSeparatedOnly: /separated only by commas/.test(lower),
    lowercaseWords: /lowercase words?/.test(lower),
    outlineOnly: /\b(?:only|for now)\b[\s\S]{0,30}\boutline\b/.test(lower),
    falseCausalPremise,
    missingSourceMaterial: /\b(?:have not|haven't|not)\s+(?:shared|provided|attached|uploaded)\b[\s\S]{0,40}\b(?:data|file|document|values|logs?)\b/.test(lower),
    ...(requiredSubject && !falseCausalPremise && !/^(?:it|this|that|this relationship|that relationship)$/.test(requiredSubject) && requiredSubject.split(/\s+/).length <= 4 ? { requiredSubject } : {}),
  };
}

export function semanticContractRepairs(answer: string, contract: AnswerContract): string[] {
  const lower = answer.toLowerCase();
  const repairs: string[] = [];
  if (contract.requiredSubject && !lower.includes(contract.requiredSubject)) repairs.push(`Name the requested subject explicitly: ${contract.requiredSubject}`);
  if (contract.falseCausalPremise && !/\b(?:confound\w*|common cause|shared (?:cause|factor)|third (?:factor|variable)|temperature|weather|season|summer|heat)\b/i.test(answer)) {
    repairs.push("Name a plausible confounder or common cause instead of stopping after rejecting the premise");
  }
  return repairs;
}

export function formatAnswerContract(contract: AnswerContract): string | null {
  const rules: string[] = [];
  if (contract.exactLiteral) rules.push(`Return exactly this single token with no punctuation: ${contract.exactLiteral}`);
  if (contract.maxWords) rules.push(`Use at most ${contract.maxWords} words; count before finishing`);
  if (contract.exactWords) rules.push(`Use exactly ${contract.exactWords} words`);
  if (contract.sentenceCount) rules.push(`Use exactly ${contract.sentenceCount} sentences`);
  if (contract.list) rules.push(`Return exactly ${contract.list.count} ${contract.list.style} items`);
  if (contract.noIntroduction) rules.push("Start with the requested content; no introduction");
  if (contract.noClosing) rules.push("End after the requested content; no closing sentence");
  if (contract.noBullets) rules.push("Use no bullet or numbered list markers");
  if (contract.forbiddenTerms.length) rules.push(`Do not use these terms: ${contract.forbiddenTerms.join(", ")}`);
  if (contract.allowedLiterals) rules.push(`Return only one of these exact tokens with no punctuation: ${contract.allowedLiterals.join(" or ")}`);
  if (contract.commaSeparatedOnly) rules.push("Separate items only with commas; use no spaces or final punctuation");
  if (contract.lowercaseWords) rules.push("Use lowercase words only");
  if (contract.falseCausalPremise) rules.push("Correct the premise explicitly: correlation does not prove causation; name a plausible confounder or common cause");
  if (contract.missingSourceMaterial) rules.push("Ask for the missing source material first; do not ask optional presentation preferences before it is available");
  if (!rules.length) return null;
  return `CURRENT-TURN OUTPUT CONTRACT (higher priority than history and memory):\n${rules.map((rule) => `- ${rule}`).join("\n")}\nSilently verify every rule before returning the answer.`;
}

export function memoryConflictsWithContract(content: string, contract: AnswerContract): boolean {
  const memory = content.toLowerCase();
  if ((contract.exactLiteral || contract.noBullets || contract.list || contract.sentenceCount) && /\b(?:detailed|long|paragraphs?|bullets?|numbered|format)\b/.test(memory)) return true;
  if (contract.maxWords && /\b(?:detailed|long|comprehensive|exhaustive)\b/.test(memory)) return true;
  if (contract.currentLanguage) {
    const languages = memory.match(/\b(?:python|sql|javascript|typescript|pyspark|java)\b/g) ?? [];
    if (languages.some((language) => language !== contract.currentLanguage)) return true;
  }
  if (contract.currentTone && /\b(?:tone|playful|sober|formal|friendly|professional|warm)\b/.test(memory) && !memory.includes(contract.currentTone)) return true;
  return false;
}

export function deterministicContractAnswer(contract: AnswerContract): string | null {
  if (contract.exactLiteral) return contract.exactLiteral;
  if (contract.missingSourceMaterial && contract.sentenceCount === 1) return "Could you share the source data or file needed for this request?";
  return null;
}

export function needsBufferedConformance(contract: AnswerContract) {
  return Boolean(contract.maxWords || contract.sentenceCount || contract.outlineOnly || contract.allowedLiterals || contract.falseCausalPremise || contract.missingSourceMaterial || (contract.exactWords && contract.commaSeparatedOnly));
}

export function normalizeContractAnswer(answer: string, contract: AnswerContract): string {
  let trimmed = answer.trim();
  if (contract.allowedLiterals) {
    const match = contract.allowedLiterals.find((literal) => new RegExp(`^${literal}\\b`, "i").test(trimmed));
    if (match) return match;
  }
  if (contract.exactWords && contract.commaSeparatedOnly) {
    const tokens = trimmed.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [];
    if (tokens.length >= contract.exactWords) {
      const fixed = tokens.slice(0, contract.exactWords - 1).concat(tokens.slice(contract.exactWords - 1).join(""));
      return fixed.map((token) => contract.lowercaseWords ? token.toLowerCase() : token).join(",");
    }
  }
  if (contract.outlineOnly && contract.list?.style === "outline") {
    const headings = [...trimmed.matchAll(/^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:[IVX]+|\d+)[.)]?\s+(.+?)(?:\*\*)?\s*$/gim)].map((match) => match[1].replace(/\*\*/g, "").trim());
    if (headings.length >= contract.list.count) trimmed = headings.slice(0, contract.list.count).map((heading, index) => `${index + 1}. ${heading}`).join("\n");
  }
  if (contract.list?.style === "numbered") {
    const inlineMarkers = [...trimmed.matchAll(/(?:^|\s+)(\d+[.)]\s+)/g)];
    const lineMarkers = trimmed.match(/^\s*\d+[.)]\s+/gm)?.length ?? 0;
    if (lineMarkers !== contract.list.count && inlineMarkers.length >= contract.list.count) {
      trimmed = trimmed.replace(/(?:^|\s+)(\d+[.)]\s+)/g, "\n$1").trim();
    }
  }
  if (contract.list?.style === "bullets") {
    const lineMarkers = trimmed.match(/^\s*[-*+•]\s+/gm)?.length ?? 0;
    if (lineMarkers !== contract.list.count) {
      trimmed = trimmed.replace(/(?:^|\s+)([-*+•]\s+)/g, "\n$1").trim();
    }
  }
  if (contract.sentenceCount === 1) {
    const questionEnd = trimmed.indexOf("?");
    const sentenceEnd = trimmed.search(/[.!]/);
    const end = questionEnd >= 0 ? questionEnd : sentenceEnd;
    if (end >= 0) trimmed = trimmed.slice(0, end + 1);
  }
  if (contract.maxWords) {
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    if (tokens.length > contract.maxWords) trimmed = tokens.slice(0, contract.maxWords).join(" ").replace(/[,;:]$/, "") + (/[.!?]$/.test(tokens[contract.maxWords - 1]) ? "" : "…");
  }
  return trimmed;
}

export function applySelectedMemoryToContract(contract: AnswerContract, memories: Array<{ content: string }>): AnswerContract {
  if (contract.maxWords || !memories.some((memory) => /\b(?:concise|brief|short)\b/i.test(memory.content))) return contract;
  return { ...contract, maxWords: 90 };
}

export type UnavailableCapability = "email-send" | "calendar-write" | "web-browse" | "financial-transaction" | "local-command";

export function answerUnavailableAction(question: string): { capability: UnavailableCapability; answer: string } | null {
  if (/\b(?:send|email|mail)\b[\s\S]{0,80}\b(?:email|mail|message|this|it|them|him|her|[A-Z][a-z]+)\b/.test(question)) return { capability: "email-send", answer: "I can't send email because no approved email connection is enabled. I can draft a ready-to-review message here." };
  if (/\b(?:delete|cancel|move|reschedule|create|book)\b[\s\S]{0,60}\b(?:calendar|meeting|appointment|event)\b/i.test(question)) return { capability: "calendar-write", answer: "I can't change your calendar because no approved calendar connection is enabled. I can help draft the exact change for you to review." };
  if (/\b(?:browse|search|check|look up)\b[\s\S]{0,50}\b(?:web|internet|online|today'?s?\s+(?:news|headline))\b/i.test(question)) return { capability: "web-browse", answer: "I can't browse the web because web access is not enabled. I can answer from local knowledge or help you define an approved search." };
  if (/\b(?:transfer|send|pay)\b[\s\S]{0,40}(?:[$₹€£]\s*\d|\b(?:money|funds|payment)\b)/i.test(question)) return { capability: "financial-transaction", answer: "I can't transfer money or access a payment account. I can help you review the amount, recipient, and safe steps before you make the payment yourself." };
  if (/\b(?:run|execute)\b[\s\S]{0,80}\b(?:rm\s|sudo\s|del\s|erase|delete\s+(?:a\s+)?file)/i.test(question)) return { capability: "local-command", answer: "I can't execute commands through this chat. I can explain the command and help you review a safe version, but I won't claim it ran." };
  return null;
}
