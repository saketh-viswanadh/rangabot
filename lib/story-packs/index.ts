import type { WordDocumentBrief, WordDraft } from "../word-documents.ts";
import { buildRamayanaStoryCollection } from "./ramayana.ts";

export interface StoryPack {
  id: string;
  matches: (brief: WordDocumentBrief) => boolean;
  build: (brief: WordDocumentBrief) => WordDraft;
}

const storyPacks: readonly StoryPack[] = [
  {
    id: "ramayana",
    matches: (brief) => /\bramayana\b/i.test(`${brief.title} ${brief.purpose} ${brief.sourceNotes}`),
    build: buildRamayanaStoryCollection,
  },
];

export function findStoryPack(brief: WordDocumentBrief): StoryPack | null {
  return storyPacks.find((pack) => pack.matches(brief)) ?? null;
}
