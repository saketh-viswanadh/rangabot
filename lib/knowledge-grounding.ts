import type { KnowledgeResult } from "./knowledge";
import type { ChatMessage } from "./providers/types";

export type GroundingAudit = {
  passed: boolean;
  citationCoverage: number;
  supportedCitationRate: number;
  invalidCitations: number[];
  uncitedParagraphs: number;
  weaklySupportedParagraphs: number;
  issues: string[];
};

const stopwords = new Set("a an and are as at be because been but by can could did do does for from had has have how if in into is it its may more most not of on or our should than that the their them then there these they this those through to use used using was were what when where which while who will with would you your".split(" "));

function terms(text: string) {
  return [...new Set(text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [])]
    .filter((term) => !stopwords.has(term) && !/^source$/.test(term));
}

function citedSourceNumbers(text: string) {
  return [...text.matchAll(/\[Source\s+(\d+)(?:[^\]]*)\]/gi)].map((match) => Number(match[1]));
}

export function countCitedSources(text: string) {
  return new Set(citedSourceNumbers(normalizeCitationMarkers(text))).size;
}

function normalizeCitationMarkers(text: string) {
  return text
    .replace(/\[(\d+)\]/g, "[Source $1]")
    .replace(/\n\s*\n(\[Source\s+\d+(?:[^\]]*)\])/gi, " $1");
}

function substantiveParagraphs(answer: string) {
  let localBackground = false;
  return answer.split(/\n\s*\n/).flatMap((raw) => {
    const paragraph = raw.trim();
    if (/^(?:#{1,6}\s*|\*\*)?local model background\b/i.test(paragraph)) {
      localBackground = true;
      return [];
    }
    const plain = paragraph.replace(/^[-*>\s#]+/, "").trim();
    if (localBackground || terms(plain).length < 6) return [];
    return [plain];
  });
}

function lexicalSupport(paragraph: string, source: string) {
  const claimTerms = terms(paragraph.replace(/\[Source\s+\d+(?:[^\]]*)\]/gi, ""));
  if (!claimTerms.length) return 1;
  const sourceTerms = new Set(terms(source));
  return claimTerms.filter((term) => sourceTerms.has(term)).length / claimTerms.length;
}

export function auditGroundedAnswer(answer: string, sources: KnowledgeResult[]): GroundingAudit {
  const normalizedAnswer = normalizeCitationMarkers(answer);
  const paragraphs = substantiveParagraphs(normalizedAnswer);
  const allCitations = citedSourceNumbers(normalizedAnswer);
  const invalidCitations = [...new Set(allCitations.filter((number) => number < 1 || number > sources.length))];
  const citedParagraphs = paragraphs.filter((paragraph) => citedSourceNumbers(paragraph).some((number) => number <= sources.length));
  const weaklySupported = citedParagraphs.filter((paragraph) => {
    const citations = citedSourceNumbers(paragraph).filter((number) => number >= 1 && number <= sources.length);
    return citations.every((number) => lexicalSupport(paragraph, sources[number - 1].content) <= .1);
  });
  const citationCoverage = paragraphs.length ? citedParagraphs.length / paragraphs.length : sources.length ? 0 : 1;
  const supportedCitationRate = citedParagraphs.length ? (citedParagraphs.length - weaklySupported.length) / citedParagraphs.length : sources.length ? 0 : 1;
  const issues: string[] = [];
  if (invalidCitations.length) issues.push(`invalid citations: ${invalidCitations.map((number) => `[Source ${number}]`).join(", ")}`);
  if (sources.length && citationCoverage < 2 / 3) issues.push(`only ${Math.round(citationCoverage * 100)}% of substantive vault-answer paragraphs include citations`);
  if (sources.length && supportedCitationRate < 2 / 3) issues.push(`only ${Math.round(supportedCitationRate * 100)}% of cited paragraphs have clear lexical support`);
  return {
    passed: issues.length === 0,
    citationCoverage,
    supportedCitationRate,
    invalidCitations,
    uncitedParagraphs: paragraphs.length - citedParagraphs.length,
    weaklySupportedParagraphs: weaklySupported.length,
    issues,
  };
}

export function buildGroundingRevisionInstruction(audit: GroundingAudit) {
  return `Revise your draft before returning it. Grounding audit problems:
- ${audit.issues.join("\n- ")}

Keep useful explanations, but:
1. Cite each vault-derived factual paragraph with the exact applicable [Source N].
2. Remove or qualify claims that the cited passage does not support.
3. Put uncited stable knowledge under a clearly headed "Local model background" section.
4. Never invent a source number, quotation, page, fact, or disagreement.
5. Do not discuss irrelevant retrieved passages; answer the user's question directly and concisely.
Return only the improved answer.`;
}

function stripCitationMarkers(text: string) {
  return text.replace(/\s*\[Source\s+\d+(?:[^\]]*)\]/gi, "").trim();
}

export function separateGroundedEvidence(answer: string, sources: KnowledgeResult[]) {
  const grounded: string[] = [];
  const background: string[] = [];
  let explicitBackground = false;
  for (const raw of normalizeCitationMarkers(answer).split(/\n\s*\n/)) {
    const paragraph = raw.trim();
    if (!paragraph || /^>\s*\*\*Grounding note:/i.test(paragraph)) continue;
    if (/^(?:#{1,6}\s*|\*\*)?local model background\b/i.test(paragraph)) {
      explicitBackground = true;
      continue;
    }
    if (explicitBackground) {
      background.push(stripCitationMarkers(paragraph));
      continue;
    }
    if (/^#{1,6}\s|^\*\*[^*]+\*\*$/.test(paragraph)) continue;
    const citations = citedSourceNumbers(paragraph).filter((number) => number >= 1 && number <= sources.length);
    const supported = citations.some((number) => lexicalSupport(paragraph, sources[number - 1].content) > .1);
    if (supported) {
      grounded.push(paragraph);
      continue;
    }
    const inferred = sources
      .map((source, index) => ({ number: index + 1, support: lexicalSupport(paragraph, source.content) }))
      .sort((left, right) => right.support - left.support)[0];
    if (inferred && inferred.support >= .2) grounded.push(`${stripCitationMarkers(paragraph)} [Source ${inferred.number}]`);
    else background.push(stripCitationMarkers(paragraph));
  }
  const sections: string[] = [];
  if (grounded.length) sections.push(`## Vault-grounded answer\n\n${grounded.join("\n\n")}`);
  if (background.length) sections.push(`## Local model background\n\n> The following explanation was not verified against the retrieved vault passages.\n\n${background.join("\n\n")}`);
  return sections.join("\n\n");
}

export async function generateGroundedTeacherAnswer(
  messages: ChatMessage[],
  sources: KnowledgeResult[],
  complete: (messages: ChatMessage[]) => Promise<string>,
) {
  const draft = normalizeCitationMarkers(await complete(messages));
  let answer = draft;
  let audit = auditGroundedAnswer(answer, sources);
  let revised = false;
  let separated = false;
  if (!audit.passed) {
    revised = true;
    const revision = normalizeCitationMarkers(await complete([
      ...messages,
      { role: "assistant", content: draft },
      { role: "user", content: buildGroundingRevisionInstruction(audit) },
    ]));
    const revisionAudit = auditGroundedAnswer(revision, sources);
    const auditQuality = (value: GroundingAudit) => Number(value.passed) * 10 + value.citationCoverage + value.supportedCitationRate - value.invalidCitations.length;
    if (auditQuality(revisionAudit) >= auditQuality(audit)) {
      answer = revision;
      audit = revisionAudit;
    }
  }
  if (!audit.passed) {
    separated = true;
    answer = separateGroundedEvidence(answer, sources);
    audit = auditGroundedAnswer(answer, sources);
  }
  if (!audit.passed) {
    answer += `\n\n> **Grounding note:** Rangabot could not verify a sufficient vault-grounded answer. ${audit.issues.join("; ")}. The clearly labelled background may still be useful, but verify it before relying on it.`;
  }
  return { answer, audit, revised, separated };
}
