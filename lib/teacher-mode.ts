import type { KnowledgeResult } from "./knowledge";
import type { ChatMessage } from "./providers/types";

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
    { role: "system", content: "You are Rangabot in Teacher Mode. Answer the user's actual question directly and teach simply before adding detail. First silently decide which retrieved passages directly support the requested explanation; ignore off-topic or merely adjacent passages and never discuss their irrelevance. Treat useful local passages as primary evidence and cite each vault-derived factual paragraph with the exact marker [Source N]—never [N], never a made-up number. When passages do not cover a stable foundational point, give the useful explanation under a clearly headed Local model background section instead of forcing a citation. Never present model background as source-verified or current. Preserve real disagreements and distinguish mythology or historical variants." },
    ...history,
    { role: "user", content: `QUESTION:\n${question}\n\nLOCAL KNOWLEDGE VAULT PASSAGES:\n${formatKnowledgeContext(sources)}\n\nAnswer the question using these passages as primary evidence. When several sources contribute, compare and connect their ideas into one explanation rather than summarizing each passage in sequence. Preserve meaningful disagreements. Include inline citations for vault-derived claims.` },
  ];
}
