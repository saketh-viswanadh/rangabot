import analyticsManifest from "../config/expert-packs/analytics.json" with { type: "json" };
import { type ExpertPackManifest, validateExpertPackManifest } from "./expert-packs.ts";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function loadBundledManifest(value: unknown): ExpertPackManifest {
  const validation = validateExpertPackManifest(value);
  if (!validation.valid) throw new Error(`Invalid bundled Expert Pack manifest: ${validation.errors.join("; ")}`);
  return deepFreeze(structuredClone(value) as ExpertPackManifest);
}

const bundledPacks = Object.freeze([loadBundledManifest(analyticsManifest)]);

if (new Set(bundledPacks.map((pack) => pack.id)).size !== bundledPacks.length) {
  throw new Error("Bundled Expert Pack ids must be unique.");
}

export function listExpertPackManifests(): readonly ExpertPackManifest[] {
  return bundledPacks;
}

export function getExpertPackManifest(id: string): ExpertPackManifest | null {
  return bundledPacks.find((pack) => pack.id === id) ?? null;
}
