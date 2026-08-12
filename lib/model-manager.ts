import { Buffer } from "node:buffer";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import modelRegistry from "../config/models.json" with { type: "json" };
import { getConfiguredChatModel, getLocalOllamaBaseUrl } from "./local-runtime-config.ts";
import { supportsPosixPermissions, writePrivateJsonFileAtomic } from "./private-storage.ts";
import { runtimePaths } from "./runtime-paths.ts";

export const MODEL_PREFERENCES_SCHEMA_VERSION = 1;
export const MODEL_PREFERENCES_MAX_BYTES = 2_048;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}(?::[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/;

export type ModelPreference = Readonly<{ schemaVersion: 1; selectedModel: string; revision: number; updatedAt: string | null }>;
export type ManagedModelView = Readonly<{ id: string; label: string; installed: boolean; selected: boolean; recommended: boolean; kind: "chat" | "embedding" | "unqualified"; selectable: boolean; tier?: string; downloadSize?: string; minimumMemoryGb?: number; uses?: readonly string[] }>;

const defaultPreference = (): ModelPreference => Object.freeze({ schemaVersion: 1, selectedModel: getConfiguredChatModel(), revision: 0, updatedAt: null });

export function validModelId(value: unknown): value is string {
  return typeof value === "string" && MODEL_ID.test(value);
}

function parsePreference(value: unknown): ModelPreference {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Model preferences are malformed.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "revision,schemaVersion,selectedModel,updatedAt"
    || record.schemaVersion !== 1 || !validModelId(record.selectedModel)
    || !Number.isSafeInteger(record.revision) || Number(record.revision) < 0
    || (record.updatedAt !== null && (typeof record.updatedAt !== "string" || new Date(record.updatedAt).toISOString() !== record.updatedAt))) {
    throw new Error("Model preferences have an incompatible schema.");
  }
  return Object.freeze({ schemaVersion: 1, selectedModel: record.selectedModel, revision: Number(record.revision), updatedAt: record.updatedAt as string | null });
}

export function readModelPreference(path = runtimePaths.modelPreferences): ModelPreference {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (supportsPosixPermissions() ? constants.O_NOFOLLOW : 0));
    const opened = fstatSync(descriptor);
    const status = lstatSync(path);
    if (status.isSymbolicLink() || !status.isFile() || !opened.isFile() || status.dev !== opened.dev || status.ino !== opened.ino
      || opened.size > MODEL_PREFERENCES_MAX_BYTES || (supportsPosixPermissions() && (opened.mode & 0o077) !== 0)) {
      throw new Error("Model preferences are not a bounded private file.");
    }
    return parsePreference(JSON.parse(readFileSync(descriptor, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultPreference();
    throw error;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export function selectedChatModel() {
  return runtimePaths.mode === "configured" ? readModelPreference().selectedModel : getConfiguredChatModel();
}

export function updateSelectedChatModel(input: { modelId: unknown; expectedRevision: unknown }) {
  if (!validModelId(input.modelId) || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0) throw new Error("A valid model and preference revision are required.");
  const current = readModelPreference();
  if (current.revision !== input.expectedRevision) throw new Error("Model selection changed in another local window.");
  const next: ModelPreference = Object.freeze({ schemaVersion: 1, selectedModel: input.modelId, revision: current.revision + 1, updatedAt: new Date().toISOString() });
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (Buffer.byteLength(text) > MODEL_PREFERENCES_MAX_BYTES) throw new Error("Model preferences exceed the private file limit.");
  writePrivateJsonFileAtomic(runtimePaths.modelPreferences, next, { trustedRoot: runtimePaths.dataRoot });
  return next;
}

export async function readInstalledModels(fetcher: typeof fetch = fetch) {
  const response = await fetcher(`${getLocalOllamaBaseUrl()}/api/tags`, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`The local model runtime returned HTTP ${response.status}.`);
  const body = await response.json() as { models?: Array<{ name?: unknown }> };
  return [...new Set((body.models ?? []).map((model) => model.name).filter(validModelId))].sort();
}

export function buildModelViews(installed: readonly string[], preference = readModelPreference()): ManagedModelView[] {
  const catalog = new Map(modelRegistry.models.map((model) => [model.id, model]));
  const embeddingCatalog = new Map(modelRegistry.embeddingModels.map((model) => [model.id, model]));
  return [...new Set([...modelRegistry.models.map((model) => model.id), ...installed])].map((id) => {
    const model = catalog.get(id);
    const embedding = embeddingCatalog.get(id) ?? embeddingCatalog.get(id.replace(/:latest$/, ""));
    const kind = model ? "chat" : embedding ? "embedding" : "unqualified";
    const selectable = Boolean(model) && installed.includes(id);
    return Object.freeze({ id, label: model?.label ?? embedding?.label ?? id, installed: installed.includes(id), selected: selectable && preference.selectedModel === id,
      recommended: Boolean(model), kind, selectable,
      ...(model ? { tier: model.tier, downloadSize: model.downloadSize, minimumMemoryGb: model.minimumMemoryGb, uses: Object.freeze([...model.uses]) }
        : embedding ? { downloadSize: embedding.downloadSize, uses: Object.freeze([...embedding.uses]) } : {}) });
  });
}

export function isRecommendedModel(modelId: string) { return modelRegistry.models.some((model) => model.id === modelId); }
export function isSelectableChatModel(modelId: string, installed: readonly string[]) { return installed.includes(modelId) && isRecommendedModel(modelId); }

export async function pullRecommendedModel(modelId: unknown, fetcher: typeof fetch = fetch) {
  if (!validModelId(modelId) || !isRecommendedModel(modelId)) throw new Error("Only a reviewed RangaBot model may be installed here.");
  const response = await fetcher(`${getLocalOllamaBaseUrl()}/api/pull`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: modelId, stream: false }), cache: "no-store", signal: AbortSignal.timeout(30 * 60_000) });
  if (!response.ok) throw new Error(`The local model download failed with HTTP ${response.status}.`);
  return modelId;
}
