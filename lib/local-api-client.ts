"use client";

import {
  isAllowedLocalApiUrl,
  LOCAL_PROFILE_CONTEXT_HEADER,
  LOCAL_SESSION_COOKIE,
  LOCAL_SESSION_HEADER,
} from "./local-http-security.ts";

const profileContextStorageKey = "rangabot-profile-session-context-v1";
const profileContextPattern = /^(?:legacy|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(?:0|[1-9][0-9]{0,15})$/;
let documentProfileContext: string | null = null;

function localSessionToken() {
  const prefix = `${LOCAL_SESSION_COOKIE}=`;
  const token = document.cookie.split(";").map((entry) => entry.trim())
    .find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
  if (!token) throw new Error("Rangabot's private local session is not ready. Reload the app and try again.");
  return decodeURIComponent(token);
}

function contextFromSessionToken(token: string) {
  const parts = token.split(".");
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]{3,128}$/.test(parts[1] ?? "")) return null;
  try {
    const encoded = (parts[1] ?? "").replaceAll("-", "+").replaceAll("_", "/");
    const padding = "=".repeat((4 - encoded.length % 4) % 4);
    const bytes = Uint8Array.from(atob(`${encoded}${padding}`), (character) => character.charCodeAt(0));
    const context = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return profileContextPattern.test(context)
      ? context
      : null;
  } catch {
    return null;
  }
}

export function currentLocalProfileContext() {
  if (documentProfileContext && profileContextPattern.test(documentProfileContext)) return documentProfileContext;
  const context = contextFromSessionToken(localSessionToken());
  if (!context) throw new Error("Rangabot's active profile session is invalid. Reload the app and try again.");
  documentProfileContext = context;
  sessionStorage.setItem(profileContextStorageKey, context);
  return context;
}

export function initializeLocalProfileSessionContext() {
  const context = contextFromSessionToken(localSessionToken());
  if (!context) throw new Error("Rangabot's active profile session is invalid.");
  documentProfileContext = context;
  sessionStorage.setItem(profileContextStorageKey, context);
  return context;
}

export function adoptLocalProfileSession(response: Response) {
  const context = response.headers.get(LOCAL_PROFILE_CONTEXT_HEADER);
  if (!context || !profileContextPattern.test(context)) {
    throw new Error("Rangabot did not return a valid profile session receipt.");
  }
  documentProfileContext = context;
  sessionStorage.setItem(profileContextStorageKey, context);
  return context;
}

export function currentLocalProfileId() {
  return currentLocalProfileContext().split(":", 1)[0] ?? "legacy";
}

export function isLegacyLocalProfileContext() {
  return currentLocalProfileId() === "legacy";
}

/**
 * Browser history/read markers are intentionally ephemeral, but they must not
 * bleed between local workspaces that happen to share one loopback origin.
 * Keep the pre-Profiles key only for the legacy workspace so setup can preview
 * old state without rewriting or deleting it.
 */
export function profileScopedStorageKey(key: string) {
  const profileId = currentLocalProfileId();
  return profileId === "legacy" ? key : `${key}:profile:${profileId}`;
}

export function localApiFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const candidate = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
  if (!isAllowedLocalApiUrl(candidate, window.location.origin)) {
    throw new Error("Rangabot blocked an API request outside its private local origin.");
  }
  const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set(LOCAL_PROFILE_CONTEXT_HEADER, currentLocalProfileContext());
  let body = init.body;
  if (method !== "GET" && method !== "HEAD") {
    headers.set(LOCAL_SESSION_HEADER, localSessionToken());
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (body === undefined || body === null) body = "{}";
  }
  return fetch(input, { ...init, method, headers, body, credentials: "same-origin" });
}

export async function localApiBlob(path: string) {
  const response = await localApiFetch(path, { cache: "no-store" });
  if (!response.ok) {
    let reason = "Rangabot could not prepare the local file.";
    try {
      const data = await response.json() as { error?: string };
      if (data.error) reason = data.error;
    } catch {
      // Preserve the safe generic message for non-JSON responses.
    }
    throw new Error(reason);
  }
  return response.blob();
}

export async function downloadLocalApiFile(path: string, filename: string) {
  const blob = await localApiBlob(path);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
