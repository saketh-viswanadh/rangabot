import type { KnowledgeResult } from "./knowledge";
import type { ChatMessage } from "./providers/types";

const planningStopwords = new Set("about after also and are can compare explain for from give how into its should than that the their then these they this through using what when where which why with would".split(" "));

function planningTerms(text: string) {
  return [...new Set(text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [])].filter((term) => !planningStopwords.has(term));
}

export function buildEvidencePlan(question: string, sources: KnowledgeResult[]) {
  const questionTerms = planningTerms(question);
  const requestedParts = question
    .replace(/\?/g, "")
    .split(/\b(?:and|versus|vs\.?|compared? to|then)\b|[,;]/i)
    .map((part) => part.trim())
    .filter((part) => planningTerms(part).length >= 2)
    .slice(0, 4);
  const coverageParts = requestedParts.length ? requestedParts : [question];
  const coverageLines = coverageParts.map((part) => {
    const partTerms = planningTerms(part);
    const ranked = sources
      .map((source, index) => {
        const sourceTerms = new Set(planningTerms(`${source.title} ${source.heading ?? ""} ${source.content}`));
        const overlap = partTerms.filter((term) => sourceTerms.has(term));
        return { number: index + 1, overlap };
      })
      .filter((candidate) => candidate.overlap.length)
      .sort((left, right) => right.overlap.length - left.overlap.length)
      .slice(0, 2);
    const evidence = ranked.length
      ? ranked.map((candidate) => `[Source ${candidate.number}] (${candidate.overlap.slice(0, 5).join(", ")})`).join(" + ")
      : "no direct lexical evidence; use labelled local background or say the vault does not cover it";
    return `- ${part} -> ${evidence}`;
  });
  const sourceLines = sources.map((source, index) => {
    const sourceTerms = new Set(planningTerms(`${source.title} ${source.heading ?? ""} ${source.content}`));
    const overlap = questionTerms.filter((term) => sourceTerms.has(term)).slice(0, 8);
    const location = source.sectionPath ?? source.heading ?? (source.pageStart ? `page ${source.pageStart}` : "passage");
    return `- [Source ${index + 1}] ${source.title} — ${location}; direct query terms: ${overlap.join(", ") || "semantic match only; verify before use"}`;
  });
  return `REQUIRED ANSWER COVERAGE
${coverageLines.join("\n")}

CLAIM-TO-SOURCE PLAN
${sourceLines.join("\n") || "- No vault evidence was retrieved. Use only a clearly labelled Local model background section."}

WRITING CONTRACT
- Start with a direct answer, not a description of the sources.
- Address every REQUIRED ANSWER COVERAGE item; do not omit a requested part merely because its evidence is limited.
- Use a source only when its passage directly supports the sentence.
- Do not collapse related concepts into synonyms unless the evidence explicitly equates them; state distinctions when terminology matters.
- End every vault-grounded factual paragraph with exact markers such as [Source 1].
- When two useful sources contribute, connect their evidence in the same explanation and cite both.
- Move stable but uncited explanation under ## Local model background.
- Keep the answer focused: usually 3–6 substantive paragraphs unless the user requests more.`;
}

export function formatKnowledgeContext(sources: KnowledgeResult[]) {
  return sources.length
    ? sources.map((source, index) => {
      const location = [source.sectionPath, source.pageStart ? `page${source.pageEnd && source.pageEnd !== source.pageStart ? `s ${source.pageStart}-${source.pageEnd}` : ` ${source.pageStart}`}` : null].filter(Boolean).join(", ");
      return `[Source ${index + 1}: ${source.title}${location ? `, ${location}` : ""}, passage ${source.chunk}]\n${source.content.slice(0, 1100)}`;
    }).join("\n\n")
    : "No matching passage was found in the local Knowledge Vault.";
}

export function buildTeacherMessages(question: string, history: ChatMessage[], sources: KnowledgeResult[]): ChatMessage[] {
  return [
    { role: "system", content: "You are Rangabot in Teacher Mode. Answer the user's actual question directly and teach simply before adding detail. First silently decide which retrieved passages directly support the requested explanation; ignore off-topic or merely adjacent passages and never discuss their irrelevance. Treat useful local passages as primary evidence and cite each vault-derived factual paragraph with the exact marker [Source N]—never [N], never a made-up number. When passages do not cover a stable foundational point, give the useful explanation under a clearly headed Local model background section instead of forcing a citation. Never present model background as source-verified or current. Preserve real disagreements and distinguish mythology or historical variants. Do not treat related technical concepts as synonyms unless the evidence explicitly equates them." },
    ...history,
    { role: "user", content: `QUESTION:\n${question}\n\n${buildEvidencePlan(question, sources)}\n\nLOCAL KNOWLEDGE VAULT PASSAGES:\n${formatKnowledgeContext(sources)}\n\nWrite the finished answer now. Follow the evidence plan and writing contract. Preserve meaningful disagreements instead of blending them.` },
  ];
}
