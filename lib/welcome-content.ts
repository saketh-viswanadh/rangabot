import library from "../content/welcome-library.json" with { type: "json" };

export type WelcomeLine = {
  text: string;
  credit: string;
  kind: "QUOTE" | "JOKE" | "THOUGHT";
};

export const welcomeLibraryUpdatedAt = library.updatedAt;

export const welcomeLines: WelcomeLine[] = [
  ...library.quotes.map((text) => ({ text, credit: "Rangabot", kind: "QUOTE" as const })),
  ...library.jokes.map((text) => ({ text, credit: "Rangabot", kind: "JOKE" as const })),
  ...library.thoughts.map((text) => ({ text, credit: "Rangabot", kind: "THOUGHT" as const })),
];

export const WELCOME_HISTORY_LIMIT = 60;

export function parseWelcomeHistory(value: string | null) {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((index): index is number => Number.isInteger(index) && index >= 0 && index < welcomeLines.length);
  } catch {
    return [];
  }
}

export function chooseWelcomeIndex(
  currentIndex: number,
  recentIndices: number[],
  random: () => number = Math.random,
) {
  const blocked = new Set([...recentIndices.slice(-WELCOME_HISTORY_LIMIT), currentIndex]);
  let candidates = welcomeLines.map((_, index) => index).filter((index) => !blocked.has(index));

  const currentKind = welcomeLines[currentIndex]?.kind;
  const differentKind = candidates.filter((index) => welcomeLines[index].kind !== currentKind);
  if (differentKind.length > 0) candidates = differentKind;
  if (candidates.length === 0) candidates = welcomeLines.map((_, index) => index).filter((index) => index !== currentIndex);

  return candidates[Math.floor(random() * candidates.length)] ?? 0;
}

export function appendWelcomeHistory(recentIndices: number[], nextIndex: number) {
  return [...recentIndices.filter((index) => index !== nextIndex), nextIndex].slice(-WELCOME_HISTORY_LIMIT);
}
