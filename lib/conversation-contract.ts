import type { ChatMessage } from "./providers/types.ts";
import { deriveSemanticTaskFrame } from "./conversation-task-frame.ts";

export type ListConstraint = { count: number; style: "numbered" | "bullets" | "outline" };
export type VerifiedReasoningFact = { statement: string; requiredTerms: string[] };
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
  forbiddenWords: string[];
  currentLanguage?: string;
  currentTone?: string;
  allowedLiterals?: string[];
  commaSeparatedOnly: boolean;
  lowercaseWords: boolean;
  outlineOnly: boolean;
  premiseVerification: boolean;
  falseCausalPremise: boolean;
  missingSourceMaterial: boolean;
  finishedTextOnly: boolean;
  requiredSubject?: string;
  verifiedReasoningFacts: VerifiedReasoningFact[];
};

const numberWords: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

function count(value: string | undefined) {
  if (!value) return undefined;
  return /^\d+$/.test(value) ? Number(value) : numberWords[value.toLowerCase()];
}

function compactNumber(value: number) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}

export function deriveVerifiedReasoningFacts(request: string): VerifiedReasoningFact[] {
  const facts: VerifiedReasoningFact[] = [];
  const speedup = request.match(/\b(?:takes?|runtime(?:\s+is)?|requires?)\s+(\d+(?:\.\d+)?)\s*(seconds?|minutes?|hours?)[\s\S]{0,100}?\b(\d+(?:\.\d+)?)\s*(?:times|x|×)\s+faster\b/i);
  if (speedup) {
    const original = Number(speedup[1]);
    const factor = Number(speedup[3]);
    if (Number.isFinite(original) && Number.isFinite(factor) && original >= 0 && factor > 0) {
      const result = compactNumber(original / factor);
      facts.push({ statement: `Verified speedup calculation: ${compactNumber(original)} / ${compactNumber(factor)} = ${result} ${speedup[2].toLowerCase()}.`, requiredTerms: [result] });
    }
  }
  const accuracy = request.match(/\b(\d+(?:\.\d+)?)%\s+accuracy\b/i);
  const classShare = request.match(/\b(\d+(?:\.\d+)?)%\s+(?:of\s+)?(?:the\s+)?(?:cases?|examples?|records?|observations?)\s+(?:are|is)\s+([\p{L}][\p{L}\p{N}_-]{0,40})\b/iu);
  const explicitlyBinary = /\b(?:binary|two[- ]class)\b/i.test(request);
  if (accuracy && classShare && explicitlyBinary) {
    const share = Number(classShare[1]);
    if (Number.isFinite(share) && share >= 0 && share <= 100) {
      const baseline = compactNumber(Math.max(share, 100 - share));
      facts.push({ statement: `Verified majority-class baseline: always predicting the majority class yields ${baseline}% accuracy; compare the stated ${compactNumber(Number(accuracy[1]))}% accuracy against that baseline and inspect class-specific errors.`, requiredTerms: [baseline, "baseline"] });
    }
  }
  return facts;
}

export function latestUserRequest(messages: ChatMessage[]) {
  return [...messages].reverse().find((message) => message.role === "user")?.content.trim() ?? "";
}

export function compileAnswerContract(messages: ChatMessage[]): AnswerContract {
  const latestRequest = latestUserRequest(messages);
  const lower = latestRequest.toLowerCase();
  const taskFrame = deriveSemanticTaskFrame(latestRequest);
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
  const forbiddenMatches = [...latestRequest.matchAll(/(?:do not|don't)\s+(?:use|include|mention)\s+(?:(?:the\s+)?(?:exact\s+)?(word|phrase)\s+)?(?:["“]([^"”\r\n]{1,200})["”]|'([^'\r\n]{1,200})'|([\p{L}\p{N}_-]+))/giu)];
  const forbiddenTerms = forbiddenMatches.map((match) => match[2] ?? match[3] ?? match[4]);
  const forbiddenWords = forbiddenMatches
    .filter((match) => match[1]?.toLowerCase() === "word" || (!match[1] && !/\s/u.test(match[2] ?? match[3] ?? match[4])))
    .map((match) => match[2] ?? match[3] ?? match[4]);
  const currentLanguage = lower.match(/\buse\s+(python|sql|javascript|typescript|pyspark|r|java)\b/)?.[1];
  const currentTone = taskFrame?.tone?.toLowerCase() ?? lower.match(/\b(sober|formal|friendly|playful|professional|technical|warm|concise|brief)\b/)?.[1];
  const choiceMatch = latestRequest.match(/(?:answer|reply)(?:\s+with)?\s+only\s+([\p{L}\p{N}_-]+)\s+or\s+([\p{L}\p{N}_-]+)\s*:/iu);
  const requiredSubject = lower.match(/\bexplain\s+(?:the\s+)?(.+?)(?:\s+to\b|\s+for\b|\s+in\b|[,.?:]|$)/)?.[1]?.trim();
  const premiseVerification = /^(?:since|because|given that|assuming that|as)\b[\s\S]{0,220}\b(?:explain|tell me|show|prove|why)\b/.test(lower);
  const falseCausalPremise = /\b(?:correlation|association)\b[\s\S]{0,40}\b(?:proves?|means?|causes?|implies?)\b[\s\S]{0,20}\bcaus/.test(lower);
  const verifiedReasoningFacts = deriveVerifiedReasoningFacts(latestRequest);
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
    forbiddenWords,
    ...(currentLanguage ? { currentLanguage } : {}),
    ...(currentTone ? { currentTone } : {}),
    ...(choiceMatch ? { allowedLiterals: [choiceMatch[1], choiceMatch[2]] } : {}),
    commaSeparatedOnly: /separated only by commas/.test(lower),
    lowercaseWords: /lowercase words?/.test(lower),
    outlineOnly: /\b(?:only|for now)\b[\s\S]{0,30}\boutline\b/.test(lower),
    premiseVerification,
    falseCausalPremise,
    finishedTextOnly: taskFrame?.intent === "compose",
    verifiedReasoningFacts,
    missingSourceMaterial: /\b(?:have not|haven't|not)\s+(?:shared|provided|attached|uploaded)\b[\s\S]{0,40}\b(?:data|file|document|values|logs?)\b/.test(lower),
    ...(requiredSubject && !falseCausalPremise && !/^(?:it|this|that|this relationship|that relationship)$/.test(requiredSubject) && requiredSubject.split(/\s+/).length <= 4 ? { requiredSubject } : {}),
  };
}

export function semanticContractRepairs(answer: string, contract: AnswerContract): string[] {
  const lower = answer.toLowerCase();
  const repairs: string[] = [];
  if (contract.requiredSubject && !lower.includes(contract.requiredSubject)) repairs.push(`Name the requested subject explicitly: ${contract.requiredSubject}`);
  if (contract.falseCausalPremise) {
    if (!/\bcorrelation\b[\s\S]{0,30}\b(?:does not|doesn't|cannot|can't|never)\b[\s\S]{0,20}\b(?:prove|establish|show|imply|mean)\b[\s\S]{0,15}\bcaus/i.test(answer)) {
      repairs.push("State explicitly that correlation does not prove causation");
    }
    if (!/\b(?:confound\w*|common cause|shared (?:cause|factor)|third (?:factor|variable))\b/i.test(answer)) {
      repairs.push("Name a plausible confounder or common cause instead of stopping after rejecting the premise");
    }
  }
  for (const fact of contract.verifiedReasoningFacts) {
    const missing = fact.requiredTerms.filter((term) => !lower.includes(term.toLowerCase()));
    if (missing.length) repairs.push(`Preserve this locally verified reasoning fact: ${fact.statement}`);
  }
  return repairs;
}

export function chooseSemanticRepair(original: string, candidate: string, contract: AnswerContract): string {
  const normalizedOriginal = normalizeContractAnswer(original, contract);
  const normalizedCandidate = normalizeContractAnswer(candidate, contract);
  const originalIssues = semanticContractRepairs(normalizedOriginal, contract).length;
  const candidateIssues = semanticContractRepairs(normalizedCandidate, contract).length;
  if (candidateIssues >= originalIssues) return normalizedOriginal;
  const originalWords = normalizedOriginal.split(/\s+/).filter(Boolean).length;
  const candidateWords = normalizedCandidate.split(/\s+/).filter(Boolean).length;
  const minimumUsefulWords = contract.exactWords ?? (contract.maxWords && contract.maxWords < 8 ? Math.min(contract.maxWords, 3) : 8);
  if (candidateWords < minimumUsefulWords && candidateWords < Math.ceil(originalWords * 0.5)) return normalizedOriginal;
  return normalizedCandidate;
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
  if (contract.premiseVerification) rules.push("The request supplies a premise: verify it independently before answering; if any part is false, correct it explicitly and do not continue as though it were true");
  if (contract.falseCausalPremise) rules.push("Correct the premise explicitly: correlation does not prove causation; name a plausible confounder or common cause");
  for (const fact of contract.verifiedReasoningFacts) rules.push(fact.statement);
  if (contract.missingSourceMaterial) rules.push("Ask for the missing source material first; do not ask optional presentation preferences before it is available");
  if (contract.finishedTextOnly) rules.push("Return only the finished text; no label, wrapper, surrounding quotation marks, preface, explanation, or follow-up offer unless explicitly requested");
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
  return Boolean(contract.maxWords || contract.sentenceCount || contract.outlineOnly || contract.allowedLiterals || contract.premiseVerification || contract.falseCausalPremise || contract.verifiedReasoningFacts.length || contract.missingSourceMaterial || contract.finishedTextOnly || (contract.exactWords && contract.commaSeparatedOnly));
}

export function normalizeContractAnswer(answer: string, contract: AnswerContract): string {
  let trimmed = answer.trim().replace(/^(?:assistant|answer|response)\s*:?\s*(?:\r?\n)+/i, "");
  const requestedQuotation = /\b(?:quote|quotation|quoted|verbatim)\b/i.test(contract.latestRequest);
  if (!requestedQuotation && trimmed.startsWith('"') && !trimmed.slice(1).includes('"')) trimmed = trimmed.slice(1).trimStart();
  if (!requestedQuotation && trimmed.startsWith("“") && !trimmed.slice(1).includes("”")) trimmed = trimmed.slice(1).trimStart();
  if (!requestedQuotation && trimmed.endsWith('"') && !trimmed.slice(0, -1).includes('"')) trimmed = trimmed.slice(0, -1).trimEnd();
  if (!requestedQuotation && trimmed.endsWith("”") && !trimmed.slice(0, -1).includes("“")) trimmed = trimmed.slice(0, -1).trimEnd();
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
    const tokens = [...trimmed.matchAll(/\S+/g)];
    if (tokens.length > contract.maxWords) {
      const finalToken = tokens[contract.maxWords - 1];
      trimmed = trimmed.slice(0, finalToken.index! + finalToken[0].length).replace(/[,;:]$/, "") + (/[.!?]$/.test(finalToken[0]) ? "" : "…");
    }
  }
  return trimmed;
}

export function enforceReasoningInvariants(answer: string, contract: AnswerContract): string {
  const normalized = normalizeContractAnswer(answer, contract);
  const repairs = semanticContractRepairs(normalized, contract);
  const safeguards: string[] = [];
  if (contract.falseCausalPremise) {
    if (repairs.includes("State explicitly that correlation does not prove causation")) safeguards.push("Correlation does not prove causation.");
    if (repairs.includes("Name a plausible confounder or common cause instead of stopping after rejecting the premise")) safeguards.push("A shared third variable can drive both outcomes.");
  }
  for (const fact of contract.verifiedReasoningFacts) {
    if (fact.requiredTerms.some((term) => !normalized.toLowerCase().includes(term.toLowerCase()))) safeguards.push(fact.statement);
  }
  return safeguards.length ? normalizeContractAnswer(`${safeguards.join(" ")}\n\n${normalized}`, contract) : normalized;
}

export function applySelectedMemoryToContract(contract: AnswerContract, memories: Array<{ content: string }>): AnswerContract {
  if (contract.maxWords || !memories.some((memory) => /\b(?:concise|brief|short)\b/i.test(memory.content))) return contract;
  return { ...contract, maxWords: 90 };
}

export type UnavailableCapability = "email-send" | "calendar-write" | "web-browse" | "financial-transaction" | "local-command";

function requestedMessageBody(question: string) {
  return (question.match(/\b(?:saying|that|with (?:the )?message|message\s*(?:is|:))\s+([\s\S]{1,500})$/i)?.[1]
    ?? question.match(/:\s*([\s\S]{1,500})$/)?.[1])
    ?.trim().replace(/[.!?\s]+$/, "");
}

function emailDraftContinuation(question: string) {
  const recipientMatch = question.match(/\bto\s+(?:(?:my|our)\s+)?([\p{L}][\p{L}'-]{0,60}|[\w.+-]+@[\w.-]+)\b/iu)
    ?? question.match(/\b(?:email|mail|message)\s+(?:(?:my|our)\s+)?([\p{L}][\p{L}'-]{0,60}|[\w.+-]+@[\w.-]+)\b/iu)
    ?? question.match(/\b(?:send|forward|deliver)\s+(?:(?:my|our)\s+)?([\p{L}][\p{L}'-]{0,60})\s+(?:an?|the|this|that|my|our)\s+[\p{L}][\p{L}'-]{1,60}\b/iu)
    ?? question.match(/\b(?:send|forward|deliver)\s+(?:(?:my|our)\s+)?([\p{L}][\p{L}'-]{0,60})\s+(?:(?:an?|the)\s+)?(?:note|update|reply|message|email|mail)\b/iu);
  const recipient = recipientMatch?.[1];
  const requestedMessage = requestedMessageBody(question);
  const boundary = "I can't send email because no approved email connection is enabled. Nothing was sent.";
  if (!requestedMessage) return `${boundary} Tell me the recipient, subject, and what the message should say, and I can draft it here for review.`;
  const body = `${requestedMessage[0]?.toUpperCase() ?? ""}${requestedMessage.slice(1)}.`;
  return `${boundary}\n\n**Draft for review**\n\n${recipient ? `Hi ${recipient},` : "Hello,"}\n\n${body}\n\nBest,\n[Your name]`;
}

function calendarContinuation(question: string) {
  const requestedMessage = requestedMessageBody(question);
  const boundary = "I can't change your calendar or notify attendees because no approved calendar or messaging connection is enabled. Nothing was scheduled or sent.";
  if (!requestedMessage) return `${boundary} I can draft the exact calendar change or attendee note here for you to review.`;
  const body = `${requestedMessage[0]?.toUpperCase() ?? ""}${requestedMessage.slice(1)}.`;
  return `${boundary}\n\n**Attendee note for review**\n\nHello,\n\n${body}\n\nBest,\n[Your name]`;
}

function actionIsDeclined(question: string, action: RegExp) {
  return question.split(/[.;\n]|\bbut\b/i).some((clause) => /\b(?:cannot|can't|do not|don't|dont|never|without|will not|won't)\b/i.test(clause) && action.test(clause));
}

function actionDecisionText(question: string) {
  const actionIndex = question.search(/\b(?:send|forward|deliver|email|mail|message|transfer|pay|run|execute|delete|cancel|move|reschedule|schedule|create|book|browse|search|check|look\s+up)\b/i);
  if (actionIndex < 0) return question;
  const afterAction = question.slice(actionIndex);
  const bodyMarker = afterAction.search(/\b(?:saying|that|with\s+(?:the\s+)?message|message\s*(?:is|:))\b|:\s*/i);
  return bodyMarker > 0 ? question.slice(0, actionIndex + bodyMarker) : question;
}

function asksForActionAdviceOrInstruction(question: string) {
  const assistantDirectedExecution = /^\s*(?:hey[,!]?\s+)?(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:send|forward|deliver|email|mail|message|transfer|pay|run|execute|delete|cancel|move|reschedule|schedule|create|book|browse|search|check|look\s+up)\b/i.test(question);
  if (assistantDirectedExecution) return false;
  return /^\s*(?:who|what|when|where|why|how)\b/i.test(question)
    || /\bshould\s+(?:i|we|you)\b|\b(?:can|could|may|would|will)\s+(?:i|we)\b|\b(?:am\s+i|are\s+we)\b|\bhow\s+(?:do|can|should|would)\s+i\b/i.test(question)
    || /\b(?:is\s+it|would\s+it\s+be)\s+(?:okay|ok|safe|wise|advisable|a\s+good\s+idea)\s+to\b/i.test(question)
    || /\b(?:do\s+you\s+think|would\s+you\s+recommend)\b[\s\S]{0,60}\bshould\b/i.test(question)
    || /\bwhat\s+(?:happens|would\s+happen)\s+if\b/i.test(question)
    || /\bwhat(?:['’]s|\s+is)\s+(?:the\s+)?(?:best|right|safest|easiest)\s+(?:way|approach)\s+to\b/i.test(question)
    || /\bwhat\s+(?:are|would\s+be)\s+(?:the\s+)?(?:steps|instructions)\b/i.test(question)
    || /\b(?:give|show|list)\s+(?:me\s+)?(?:the\s+)?(?:steps|instructions)\s+(?:for|to)\b/i.test(question)
    || /\bwalk\s+me\s+through\b/i.test(question)
    || /\b(?:explain|tell\s+me|advise|help\s+me\s+decide)\b[\s\S]{0,90}\b(?:whether|if|how|should)\b/i.test(question);
}

function isLikelyRecipientToken(value: string) {
  const token = value.replace(/[,:;.!?]+$/, "");
  return /^[\w.+-]+@[\w.-]+$/u.test(token)
    || /^[\p{Lu}][\p{L}'-]{1,60}$/u.test(token)
    || /^(?:him|her|them|me|us|boss|manager|client|customer|team|attendees|participants|owner|group)$/iu.test(token);
}

function startsWithDirectEmailRecipient(question: string) {
  const match = question.match(/^\s*(?:hey[,!]?\s+)?(?:email|mail|message)\s+(?:(my|our)\s+)?(\S{1,120})(?:\s+([\s\S]{1,120}))?/iu);
  if (!match) return false;
  const token = match[2].replace(/[,:;.!?]+$/, "");
  const trailing = match[3] ?? "";
  return isLikelyRecipientToken(token)
    || Boolean(match[1] && /^[\p{L}][\p{L}'-]{1,60}$/u.test(token))
    || /^(?:an?|the|this|that|my|our)\s+[\p{L}\p{N}]/iu.test(trailing)
    || /^the$/i.test(token) && /^\s*(?:hey[,!]?\s+)?(?:email|mail|message)\s+the\s+(?:team|attendees|participants|client|customer|manager|owner|group)\b/iu.test(question)
    || /\b(?:saying|that|about|regarding|with\s+(?:the\s+)?(?:subject|message))\b/i.test(question);
}

function hasExplicitRecipientDelivery(question: string) {
  const recipientFirst = question.match(/\b(?:send|forward|deliver)\s+(?:(my|our)\s+)?(\S{1,120})\s+([\s\S]{1,120})/iu);
  const hasRecipientFirst = recipientFirst
    && (isLikelyRecipientToken(recipientFirst[2]) || Boolean(recipientFirst[1] && /^[\p{L}][\p{L}'-]{1,60}$/u.test(recipientFirst[2])))
    && (/^(?:an?|the|this|that|my|our)\s+[\p{L}\p{N}]/iu.test(recipientFirst[3])
      || /^(?:note|update|reply|message|email|mail)\b/iu.test(recipientFirst[3]));
  if (hasRecipientFirst) return true;
  const payloadFirst = question.match(/\b(?:send|forward|deliver)\s+(?:(?:an?|the|this|that|my|our)\s+)?[\p{L}][\p{L}'-]{1,60}(?:\s+[\p{L}][\p{L}'-]{1,60}){0,2}\s+to\s+(?:(my|our)\s+)?(\S{1,120})/iu);
  const payloadFirstRecipient = payloadFirst?.[2]?.replace(/[,:;.!?]+$/, "") ?? "";
  return Boolean(payloadFirst
    && (isLikelyRecipientToken(payloadFirst[2]) || Boolean(payloadFirst[1] && /^[\p{L}][\p{L}'-]{1,60}$/u.test(payloadFirstRecipient))));
}

export function answerUnavailableAction(question: string): { capability: UnavailableCapability; answer: string } | null {
  const decisionText = actionDecisionText(question);
  const asksForAdvice = asksForActionAdviceOrInstruction(decisionText);
  const emailAction = /\b(?:send|forward|deliver|email|mail|message)\b/i;
  const emailInstruction = /\b(?:explain|teach|teaching|show|guide|tutorial|describe|create|write)\b[\s\S]{0,100}\bhow\s+to\s+(?:send|forward|deliver|email|mail|message)\b/i;
  const explicitPoliteEmail = /^\s*(?:hey[,!]?\s+)?(?:(?:please)\s+|(?:can|could|would|will)\s+you\s+(?:please\s+)?)(?:email|mail|message)\s+\S/iu.test(question);
  const directEmailRecipient = startsWithDirectEmailRecipient(question);
  const requestsEmailExecution = /\b(?:send|forward|deliver)\b[\s\S]{0,100}\b(?:email|mail|message|this|it)\b/i.test(question)
    || explicitPoliteEmail
    || directEmailRecipient
    || hasExplicitRecipientDelivery(question)
    || /\bsend\s+this\b/i.test(question);
  if (requestsEmailExecution && !asksForAdvice && !emailInstruction.test(decisionText) && !actionIsDeclined(decisionText, emailAction)) {
    return { capability: "email-send", answer: emailDraftContinuation(question) };
  }
  const writesMeetingContent = /\b(?:notes|minutes|agenda|summary|word|docx|document)\b/i.test(question);
  const calendarAction = /\b(?:delete|cancel|move|reschedule|schedule|create|book)\b[\s\S]{0,60}\b(?:calendar|meeting|appointment|event)\b/i;
  const calendarInstruction = /\b(?:explain|teach|show|tell\s+me|guide|tutorial|describe)\b[\s\S]{0,70}\bhow\s+to\s+(?:delete|cancel|move|reschedule|schedule|create|book)\b/i;
  if (!writesMeetingContent && calendarAction.test(question) && !asksForAdvice && !calendarInstruction.test(decisionText) && !actionIsDeclined(decisionText, calendarAction)) {
    return { capability: "calendar-write", answer: calendarContinuation(question) };
  }
  const webAction = /\b(?:browse|search|check|look\s+up)\b[\s\S]{0,50}\b(?:web|internet|online|today'?s?\s+(?:news|headline))\b/i;
  const webInstruction = /\b(?:explain|teach|show|guide|tutorial|describe|create|write)\b[\s\S]{0,90}\bhow\s+to\s+(?:browse|search|check|look\s+up)\b/i;
  if (webAction.test(question) && !asksForAdvice && !webInstruction.test(decisionText) && !actionIsDeclined(decisionText, webAction)) return { capability: "web-browse", answer: "I can't browse the web because web access is not enabled. I can answer from local knowledge or help you define an approved search." };
  const financialAction = /\b(?:transfer|send|pay)\b/i;
  if (!asksForAdvice && !actionIsDeclined(decisionText, financialAction)
    && /\b(?:transfer|send|pay)\b[\s\S]{0,40}(?:[$₹€£]\s*\d|\b(?:money|funds|payment)\b)/i.test(question)) return { capability: "financial-transaction", answer: "I can't transfer money or access a payment account. I can help you review the amount, recipient, and safe steps before you make the payment yourself." };
  const localCommandAction = /\b(?:run|execute)\b/i;
  if (!asksForAdvice && !actionIsDeclined(decisionText, localCommandAction)
    && /\b(?:run|execute)\b[\s\S]{0,80}\b(?:rm\s|sudo\s|del\s|erase|delete\s+(?:a\s+)?file)/i.test(question)) return { capability: "local-command", answer: "I can't execute commands through this chat. I can explain the command and help you review a safe version, but I won't claim it ran." };
  return null;
}
