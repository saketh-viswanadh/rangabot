import { Buffer } from "node:buffer";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { supportsPosixPermissions, writePrivateJsonFileAtomic } from "./private-storage.ts";
import { runtimePaths } from "./runtime-paths.ts";
import { isWelcomeMode, sanitizePreferredName, type WelcomeMode } from "./welcome-preferences.ts";
import { paletteOptions, type Appearance, type Palette } from "./appearance-preferences.ts";
import { WELCOME_HISTORY_STORAGE_KEY } from "./welcome-content.ts";

export const DESKTOP_PREFERENCES_SCHEMA_VERSION = 1;
export const DESKTOP_PREFERENCES_MAX_BYTES = 4_096;

/**
 * Complete renderer-storage inventory for the desktop persistence boundary.
 * Only the three legacy keys may be offered as an explicit same-origin import
 * preview. Rotation/read markers are UI history, not durable preferences, and
 * must never be copied into DATA_ROOT.
 */
export const DESKTOP_RENDERER_STORAGE_INVENTORY = Object.freeze({
  legacyDurableImportOnly: Object.freeze([
    "rangabot-welcome-preferences-v1",
    "rangabot-appearance",
    "rangabot-palette",
  ]),
  ephemeralUiState: Object.freeze([
    WELCOME_HISTORY_STORAGE_KEY,
    "rangabot-book-welcome-history-v1",
    "rangabot-knowledge-read",
  ]),
});

export type DesktopPreferences = Readonly<{
  schemaVersion: typeof DESKTOP_PREFERENCES_SCHEMA_VERSION;
  preferredName: string;
  welcomeMode: WelcomeMode;
  appearance: Appearance | null;
  palette: Palette;
  revision: number;
  updatedAt: string | null;
  import: Readonly<{
    source: "legacy-loopback-manual";
    importedAt: string;
  }> | null;
}>;

export type DesktopPreferencesUpdate = Readonly<{
  expectedRevision: number;
  preferredName: unknown;
  welcomeMode: unknown;
  appearance: unknown;
  palette: unknown;
}>;

const defaultPreferences: DesktopPreferences = Object.freeze({
  schemaVersion: DESKTOP_PREFERENCES_SCHEMA_VERSION,
  preferredName: "",
  welcomeMode: "mixed",
  appearance: null,
  palette: "rangabot",
  revision: 0,
  updatedAt: null,
  import: null,
});

function canonicalTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function normalizePreferenceValues(input: {
  preferredName?: unknown;
  welcomeMode?: unknown;
  appearance?: unknown;
  palette?: unknown;
}) {
  if (typeof input.preferredName !== "string") throw new Error("Desktop preferred name is invalid.");
  const preferredName = sanitizePreferredName(input.preferredName) ?? "";
  if (preferredName !== input.preferredName || Array.from(input.preferredName).length > 40
    || Buffer.byteLength(input.preferredName, "utf8") > 160) {
    throw new Error("Desktop preferred name must be canonical and bounded.");
  }
  if (!isWelcomeMode(input.welcomeMode)) throw new Error("Desktop welcome mode is invalid.");
  if (input.appearance !== null && input.appearance !== "light" && input.appearance !== "dark") {
    throw new Error("Desktop appearance is invalid.");
  }
  if (typeof input.palette !== "string" || !paletteOptions.some((choice) => choice.id === input.palette)) {
    throw new Error("Desktop palette is invalid.");
  }
  return Object.freeze({
    preferredName,
    welcomeMode: input.welcomeMode,
    appearance: input.appearance,
    palette: input.palette as Palette,
  });
}

function parseDesktopPreferences(value: unknown): DesktopPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Desktop preferences are malformed.");
  const record = value as Record<string, unknown>;
  const exactKeys = ["appearance", "import", "palette", "preferredName", "revision", "schemaVersion", "updatedAt", "welcomeMode"];
  if (Object.keys(record).sort().join(",") !== exactKeys.join(",")
    || record.schemaVersion !== DESKTOP_PREFERENCES_SCHEMA_VERSION
    || !Number.isSafeInteger(record.revision) || (record.revision as number) < 0
    || (record.updatedAt !== null && !canonicalTimestamp(record.updatedAt))) {
    throw new Error("Desktop preferences have an incompatible schema.");
  }
  let importRecord: DesktopPreferences["import"] = null;
  if (record.import !== null) {
    if (!record.import || typeof record.import !== "object" || Array.isArray(record.import)) {
      throw new Error("Desktop preference import provenance is malformed.");
    }
    const provenance = record.import as Record<string, unknown>;
    if (Object.keys(provenance).sort().join(",") !== "importedAt,source"
      || provenance.source !== "legacy-loopback-manual" || !canonicalTimestamp(provenance.importedAt)) {
      throw new Error("Desktop preference import provenance is invalid.");
    }
    importRecord = Object.freeze({ source: "legacy-loopback-manual", importedAt: provenance.importedAt });
  }
  return Object.freeze({
    schemaVersion: DESKTOP_PREFERENCES_SCHEMA_VERSION,
    ...normalizePreferenceValues(record),
    revision: record.revision as number,
    updatedAt: record.updatedAt as string | null,
    import: importRecord,
  });
}

export function readDesktopPreferences(path = runtimePaths.desktopPreferences): DesktopPreferences {
  let descriptor: number | undefined;
  try {
    const noFollow = supportsPosixPermissions() ? constants.O_NOFOLLOW : 0;
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor);
    const status = lstatSync(path);
    if (status.isSymbolicLink() || !status.isFile() || !opened.isFile()
      || status.dev !== opened.dev || status.ino !== opened.ino
      || opened.size > DESKTOP_PREFERENCES_MAX_BYTES) {
      throw new Error("Desktop preferences are not a bounded regular private file.");
    }
    if (supportsPosixPermissions() && (opened.mode & 0o077) !== 0) {
      throw new Error("Desktop preferences are not owner-private.");
    }
    const bytes = readFileSync(descriptor);
    if (bytes.byteLength > DESKTOP_PREFERENCES_MAX_BYTES) throw new Error("Desktop preferences are too large.");
    return parseDesktopPreferences(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultPreferences;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error("Desktop preferences are not a bounded regular private file.");
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export class DesktopPreferencesConflictError extends Error {
  readonly current: DesktopPreferences;
  constructor(current: DesktopPreferences) {
    super("Desktop preferences changed in another local window.");
    this.name = "DesktopPreferencesConflictError";
    this.current = current;
  }
}

export function updateDesktopPreferences(
  input: DesktopPreferencesUpdate,
  options: { path?: string; trustedDataRoot?: string; now?: string } = {},
) {
  const path = options.path ?? runtimePaths.desktopPreferences;
  const now = options.now ?? new Date().toISOString();
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !canonicalTimestamp(now)) {
    throw new Error("A valid desktop preference revision and update time are required.");
  }
  const current = readDesktopPreferences(path);
  if (current.revision !== input.expectedRevision) throw new DesktopPreferencesConflictError(current);
  const values = normalizePreferenceValues(input);
  const next: DesktopPreferences = Object.freeze({
    schemaVersion: DESKTOP_PREFERENCES_SCHEMA_VERSION,
    ...values,
    revision: current.revision + 1,
    updatedAt: now,
    import: current.import,
  });
  if (Buffer.byteLength(`${JSON.stringify(next, null, 2)}\n`, "utf8") > DESKTOP_PREFERENCES_MAX_BYTES) {
    throw new Error("Desktop preferences exceed the private file limit.");
  }
  writePrivateJsonFileAtomic(path, next, { trustedRoot: options.trustedDataRoot ?? runtimePaths.dataRoot });
  return next;
}

export function importLegacyDesktopPreferences(
  input: DesktopPreferencesUpdate,
  options: { path?: string; trustedDataRoot?: string; now?: string } = {},
) {
  const path = options.path ?? runtimePaths.desktopPreferences;
  const now = options.now ?? new Date().toISOString();
  const current = readDesktopPreferences(path);
  if (current.revision !== 0 || current.updatedAt !== null || current.import !== null) {
    return Object.freeze({ kind: "existing-wins" as const, preferences: current });
  }
  if (input.expectedRevision !== 0 || !canonicalTimestamp(now)) throw new Error("A valid legacy preference preview is required.");
  const next = Object.freeze({
    schemaVersion: DESKTOP_PREFERENCES_SCHEMA_VERSION,
    ...normalizePreferenceValues(input),
    revision: 1,
    updatedAt: now,
    import: Object.freeze({ source: "legacy-loopback-manual" as const, importedAt: now }),
  });
  if (Buffer.byteLength(`${JSON.stringify(next, null, 2)}\n`, "utf8") > DESKTOP_PREFERENCES_MAX_BYTES) {
    throw new Error("Desktop preferences exceed the private file limit.");
  }
  writePrivateJsonFileAtomic(path, next, { trustedRoot: options.trustedDataRoot ?? runtimePaths.dataRoot });
  return Object.freeze({ kind: "imported" as const, preferences: next });
}

export class DesktopPreferencesPayloadTooLargeError extends Error {
  constructor() {
    super("Desktop preference request exceeds the local size limit.");
    this.name = "DesktopPreferencesPayloadTooLargeError";
  }
}

function mutationBody(value: unknown, requireConfirmedImport: boolean): DesktopPreferencesUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("A desktop preference object is required.");
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = requireConfirmedImport
    ? ["appearance", "confirmed", "expectedRevision", "palette", "preferredName", "welcomeMode"]
    : ["appearance", "expectedRevision", "palette", "preferredName", "welcomeMode"];
  if (Object.keys(record).sort().join(",") !== expectedKeys.join(",")
    || (requireConfirmedImport && record.confirmed !== true)
    || !Number.isSafeInteger(record.expectedRevision) || (record.expectedRevision as number) < 0) {
    throw new Error("Desktop preference request has an incompatible schema.");
  }
  const update: DesktopPreferencesUpdate = {
    expectedRevision: record.expectedRevision as number,
    preferredName: record.preferredName,
    welcomeMode: record.welcomeMode,
    appearance: record.appearance,
    palette: record.palette,
  };
  normalizePreferenceValues(update);
  return update;
}

export async function readDesktopPreferencesMutation(
  request: Request,
  options: { requireConfirmedImport?: boolean } = {},
) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new Error("Desktop preference requests must use JSON.");
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) throw new Error("Desktop preference request length is invalid.");
    if (Number(contentLength) > DESKTOP_PREFERENCES_MAX_BYTES) throw new DesktopPreferencesPayloadTooLargeError();
  }
  if (!request.body) throw new Error("Desktop preference request body is missing.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > DESKTOP_PREFERENCES_MAX_BYTES) {
      await reader.cancel();
      throw new DesktopPreferencesPayloadTooLargeError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return mutationBody(JSON.parse(text), options.requireConfirmedImport === true);
}
