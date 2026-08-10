"use client";

import { isAllowedLocalApiUrl, LOCAL_SESSION_COOKIE, LOCAL_SESSION_HEADER } from "./local-http-security";

function localSessionToken() {
  const prefix = `${LOCAL_SESSION_COOKIE}=`;
  const token = document.cookie.split(";").map((entry) => entry.trim())
    .find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
  if (!token) throw new Error("Rangabot's private local session is not ready. Reload the app and try again.");
  return decodeURIComponent(token);
}

export function localApiFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const candidate = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
  if (!isAllowedLocalApiUrl(candidate, window.location.origin)) {
    throw new Error("Rangabot blocked an API request outside its private local origin.");
  }
  const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  let body = init.body;
  if (method !== "GET" && method !== "HEAD") {
    headers.set(LOCAL_SESSION_HEADER, localSessionToken());
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (body === undefined || body === null) body = "{}";
  }
  return fetch(input, { ...init, method, headers, body, credentials: "same-origin" });
}
