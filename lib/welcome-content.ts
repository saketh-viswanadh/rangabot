import library from "../content/welcome-library.json" with { type: "json" };
import type { WelcomeMode } from "./welcome-preferences.ts";

export type WelcomeLine = {
  id: string;
  text: string;
  credit: string;
  kind: "QUOTE" | "JOKE" | "THOUGHT" | "BOOK_FACT";
};

export const welcomeLibraryUpdatedAt = library.updatedAt;

function stableHash(value: string, seed: number) {
  let hash = seed >>> 0;
  for (const character of value.normalize("NFC")) {
    const point = character.codePointAt(0) ?? 0;
    hash = Math.imul(hash ^ (point & 0xffff), 0x01000193);
    hash = Math.imul(hash ^ (point >>> 16), 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function welcomeLineId(kind: WelcomeLine["kind"], text: string) {
  const normalized = `${kind}\u0000${text.normalize("NFC")}`;
  const reverse = Array.from(normalized).reverse().join("");
  return `${kind.toLowerCase()}-${stableHash(normalized, 0x811c9dc5)}-${stableHash(reverse, 0x9e3779b9)}`;
}

function line(kind: WelcomeLine["kind"], text: string, credit = "Rangabot"): WelcomeLine {
  return { id: welcomeLineId(kind, text), text, credit, kind };
}

export const welcomeLines: WelcomeLine[] = [
  ...library.quotes.map((text) => line("QUOTE", text)),
  ...library.jokes.map((text) => line("JOKE", text)),
  ...library.thoughts.map((text) => line("THOUGHT", text)),
];

export const WELCOME_HISTORY_LIMIT = 60;
export const WELCOME_HISTORY_STORAGE_KEY = "rangabot-welcome-history" as const;

type WelcomeHistoryEntry = string | number;

function historyId(value: WelcomeHistoryEntry) {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 && value < welcomeLines.length
    ? welcomeLines[value].id
    : null;
  return welcomeLines.some((item) => item.id === value) ? value : null;
}

export function parseWelcomeHistory(value: string | null) {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    const ids = parsed
      .slice(-WELCOME_HISTORY_LIMIT * 2)
      .flatMap((entry) => typeof entry === "string" || typeof entry === "number" ? [historyId(entry)] : [])
      .filter((id): id is string => Boolean(id));
    return ids.reduce<string[]>((history, id) => appendWelcomeHistory(history, id), []);
  } catch {
    return [];
  }
}

export function chooseWelcomeIndex(
  currentIndex: number,
  recentEntries: readonly WelcomeHistoryEntry[],
  random: () => number = Math.random,
  mode: WelcomeMode = "mixed",
) {
  const preferredKind: Record<Exclude<WelcomeMode, "mixed">, WelcomeLine["kind"]> = {
    quotes: "QUOTE",
    jokes: "JOKE",
    thoughts: "THOUGHT",
    books: "BOOK_FACT",
  };
  const preferred = mode === "mixed" ? welcomeLines : welcomeLines.filter((item) => item.kind === preferredKind[mode]);
  const pool = preferred.length ? preferred : welcomeLines;
  const recentIds = recentEntries.slice(-WELCOME_HISTORY_LIMIT).flatMap((entry) => historyId(entry) ?? []);
  const currentId = welcomeLines[currentIndex]?.id;
  const blocked = new Set([...recentIds, ...(currentId ? [currentId] : [])]);
  let candidates = pool.filter((item) => !blocked.has(item.id));

  if (mode === "mixed") {
    const currentKind = welcomeLines[currentIndex]?.kind;
    const differentKind = candidates.filter((item) => item.kind !== currentKind);
    if (differentKind.length > 0) candidates = differentKind;
  }
  if (candidates.length === 0) candidates = pool.filter((item) => item.id !== currentId);
  if (candidates.length === 0) candidates = pool;

  const selected = candidates[Math.min(candidates.length - 1, Math.max(0, Math.floor(random() * candidates.length)))] ?? welcomeLines[0];
  return Math.max(0, welcomeLines.findIndex((item) => item.id === selected.id));
}

export function appendWelcomeHistory(recentEntries: readonly WelcomeHistoryEntry[], nextEntry: WelcomeHistoryEntry) {
  const nextId = historyId(nextEntry);
  const recentIds = recentEntries.flatMap((entry) => historyId(entry) ?? []);
  if (!nextId) return recentIds.slice(-WELCOME_HISTORY_LIMIT);
  return [...recentIds.filter((id) => id !== nextId), nextId].slice(-WELCOME_HISTORY_LIMIT);
}
