export const WELCOME_PREFERENCES_VERSION = 1 as const;
export const WELCOME_PREFERENCES_STORAGE_KEY = "rangabot-welcome-preferences-v1" as const;
export const MAX_PREFERRED_NAME_CHARACTERS = 40;

export const welcomeModes = ["mixed", "quotes", "jokes", "thoughts", "books"] as const;

export type WelcomeMode = (typeof welcomeModes)[number];

export type WelcomePreferences = {
  version: typeof WELCOME_PREFERENCES_VERSION;
  preferredName: string | null;
  mode: WelcomeMode;
};

export const defaultWelcomePreferences: WelcomePreferences = {
  version: WELCOME_PREFERENCES_VERSION,
  preferredName: null,
  mode: "mixed",
};

export function isWelcomeMode(value: unknown): value is WelcomeMode {
  return typeof value === "string" && (welcomeModes as readonly string[]).includes(value);
}

export function sanitizePreferredName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return null;
  return Array.from(normalized).slice(0, MAX_PREFERRED_NAME_CHARACTERS).join("").trim() || null;
}

export function normalizeWelcomePreferences(value: { preferredName?: unknown; mode?: unknown } = {}): WelcomePreferences {
  return {
    version: WELCOME_PREFERENCES_VERSION,
    preferredName: sanitizePreferredName(value.preferredName),
    mode: isWelcomeMode(value.mode) ? value.mode : defaultWelcomePreferences.mode,
  };
}

export function parseWelcomePreferences(value: string | null): WelcomePreferences {
  if (!value) return { ...defaultWelcomePreferences };
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return { ...defaultWelcomePreferences };
    const candidate = parsed as Record<string, unknown>;
    if (candidate.version !== WELCOME_PREFERENCES_VERSION) return { ...defaultWelcomePreferences };
    return normalizeWelcomePreferences(candidate);
  } catch {
    return { ...defaultWelcomePreferences };
  }
}

export function serializeWelcomePreferences(value: { preferredName?: unknown; mode?: unknown }): string {
  return JSON.stringify(normalizeWelcomePreferences(value));
}
