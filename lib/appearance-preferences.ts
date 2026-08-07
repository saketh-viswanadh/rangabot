export const APPEARANCE_STORAGE_KEY = "rangabot-appearance";
export const PALETTE_STORAGE_KEY = "rangabot-palette";

export const paletteOptions = [
  { id: "rangabot", label: "Rangabot" },
  { id: "monochrome", label: "Black and white" },
  { id: "graphite", label: "Graphite" },
  { id: "cement", label: "Cement" },
  { id: "moss", label: "Moss" },
  { id: "harbor", label: "Harbor" },
  { id: "plum", label: "Plum" },
  { id: "ember", label: "Ember" },
] as const;

export type Appearance = "light" | "dark";
export type Palette = (typeof paletteOptions)[number]["id"];

export const DEFAULT_PALETTE: Palette = "rangabot";

const legacyPaletteIds: Record<string, Palette> = {
  sand: "rangabot",
  sage: "moss",
  lavender: "plum",
};

export function parseAppearance(value: string | null): Appearance | null {
  return value === "light" || value === "dark" ? value : null;
}

export function parsePalette(value: string | null): Palette {
  if (value && paletteOptions.some((choice) => choice.id === value)) return value as Palette;
  return value ? legacyPaletteIds[value] ?? DEFAULT_PALETTE : DEFAULT_PALETTE;
}

export function normalizeStoredPalette(value: string | null) {
  const palette = parsePalette(value);
  return {
    palette,
    shouldPersist: value !== null && value !== palette,
  };
}
