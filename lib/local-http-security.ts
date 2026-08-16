export const LOCAL_SESSION_COOKIE = "rangabot_session";
export const LOCAL_SESSION_HEADER = "X-Rangabot-Session";
export const LOCAL_PROFILE_CONTEXT_HEADER = "X-Rangabot-Profile-Context";
export const LOCAL_BOOTSTRAP_HEADER = "X-Rangabot-Bootstrap";
export const LOCAL_BOOTSTRAP_PATH = "/api/local-session/bootstrap";
export const MAX_LOCAL_API_BODY_BYTES = 2_200_000;
export const MAX_LOCAL_PROFILE_RESTORE_BYTES = 512 * 1024 * 1024;
export const MAX_LOCAL_BOOTSTRAP_BODY_BYTES = 64;

const safeMethods = new Set(["GET", "HEAD"]);

export type LocalRequestSecurityInput = {
  url: string;
  method: string;
  headers: Headers;
  sessionCookie?: string;
  issuedSessionValid: boolean;
  profileContextValid?: boolean;
};

export type LocalRequestSecurityResult =
  | { ok: true }
  | { ok: false; status: 403 | 411 | 413 | 415; code: "forbidden" | "length-required" | "payload-too-large" | "unsupported-media-type" };

export type LocalBootstrapSecurityInput = {
  url: string;
  method: string;
  headers: Headers;
  bootstrapTokenValid: boolean;
};

function normalizedHostOrigin(host: string) {
  const value = host.trim();
  if (!value || /[\s/@\\]/.test(value)) return null;
  let parsed: URL;
  try { parsed = new URL(`http://${value}`); }
  catch { return null; }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]") return null;
  return parsed.origin;
}

export function isAllowedLoopbackHost(host: string | null) {
  return host !== null && normalizedHostOrigin(host) !== null;
}

/**
 * NextRequest canonicalizes loopback hostnames to `localhost`. Restore only
 * the authority from the separately validated Host header so downstream
 * checks still compare against the local address the client actually used.
 */
export function bindLocalRequestUrlToValidatedHost(candidate: string, host: string | null) {
  const hostOrigin = normalizedHostOrigin(host ?? "");
  if (!hostOrigin) return null;
  try {
    const normalized = new URL(candidate);
    if (normalized.protocol !== "http:") return null;
    normalized.host = new URL(hostOrigin).host;
    return normalized.href;
  } catch {
    return null;
  }
}

export function isAllowedLocalApiUrl(candidate: string, currentOrigin: string) {
  try {
    const url = new URL(candidate, currentOrigin);
    return url.origin === currentOrigin && (url.pathname === "/api" || url.pathname.startsWith("/api/"));
  } catch {
    return false;
  }
}

export function evaluateLocalBootstrapRequest(input: LocalBootstrapSecurityInput): LocalRequestSecurityResult {
  const hostOrigin = normalizedHostOrigin(input.headers.get("host") ?? "");
  if (!hostOrigin) return { ok: false, status: 403, code: "forbidden" };

  let requestUrl: URL;
  try { requestUrl = new URL(input.url); }
  catch { return { ok: false, status: 403, code: "forbidden" }; }
  if (requestUrl.origin !== hostOrigin
    || requestUrl.pathname !== LOCAL_BOOTSTRAP_PATH
    || requestUrl.search !== ""
    || input.method.toUpperCase() !== "POST") {
    return { ok: false, status: 403, code: "forbidden" };
  }

  const origin = input.headers.get("origin");
  if (!origin) return { ok: false, status: 403, code: "forbidden" };
  try {
    if (new URL(origin).origin !== hostOrigin) return { ok: false, status: 403, code: "forbidden" };
  } catch {
    return { ok: false, status: 403, code: "forbidden" };
  }
  if (input.headers.get("sec-fetch-site")?.toLowerCase() !== "same-origin" || !input.bootstrapTokenValid) {
    return { ok: false, status: 403, code: "forbidden" };
  }

  const mediaType = input.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json"
    || input.headers.has("transfer-encoding")
    || (input.headers.get("content-encoding") ?? "identity").toLowerCase() !== "identity") {
    return { ok: false, status: 415, code: "unsupported-media-type" };
  }
  const lengthHeader = input.headers.get("content-length");
  if (!lengthHeader || !/^[1-9][0-9]{0,2}$/.test(lengthHeader)) {
    return { ok: false, status: 411, code: "length-required" };
  }
  if (Number(lengthHeader) > MAX_LOCAL_BOOTSTRAP_BODY_BYTES) {
    return { ok: false, status: 413, code: "payload-too-large" };
  }
  return { ok: true };
}

export function evaluateLocalApiRequest(input: LocalRequestSecurityInput): LocalRequestSecurityResult {
  const hostOrigin = normalizedHostOrigin(input.headers.get("host") ?? "");
  if (!hostOrigin) return { ok: false, status: 403, code: "forbidden" };

  let requestUrl: URL;
  try { requestUrl = new URL(input.url); }
  catch { return { ok: false, status: 403, code: "forbidden" }; }
  if (requestUrl.origin !== hostOrigin) return { ok: false, status: 403, code: "forbidden" };

  const fetchSite = input.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return { ok: false, status: 403, code: "forbidden" };
  }

  const origin = input.headers.get("origin");
  if (origin) {
    let parsedOrigin: URL;
    try { parsedOrigin = new URL(origin); }
    catch { return { ok: false, status: 403, code: "forbidden" }; }
    if (parsedOrigin.origin !== hostOrigin) return { ok: false, status: 403, code: "forbidden" };
  }

  if (!input.issuedSessionValid || !input.sessionCookie || input.profileContextValid === false) {
    return { ok: false, status: 403, code: "forbidden" };
  }

  const method = input.method.toUpperCase();
  if (safeMethods.has(method)) return { ok: true };

  const suppliedToken = input.headers.get(LOCAL_SESSION_HEADER);
  if (!suppliedToken || suppliedToken !== input.sessionCookie) {
    return { ok: false, status: 403, code: "forbidden" };
  }
  const mediaType = input.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const profileRestore = requestUrl.pathname === "/api/profiles/restore";
  const acceptedMediaType = profileRestore ? "application/vnd.rangabot.profile-backup+json" : "application/json";
  if (mediaType !== acceptedMediaType) {
    return { ok: false, status: 415, code: "unsupported-media-type" };
  }
  if (input.headers.has("transfer-encoding") || (input.headers.get("content-encoding") ?? "identity").toLowerCase() !== "identity") {
    return { ok: false, status: 415, code: "unsupported-media-type" };
  }
  const lengthHeader = input.headers.get("content-length");
  const lengthPattern = profileRestore ? /^[1-9][0-9]{0,8}$/ : /^[1-9][0-9]{0,7}$/;
  if (!lengthHeader || !lengthPattern.test(lengthHeader)) {
    return { ok: false, status: 411, code: "length-required" };
  }
  const maximumBytes = profileRestore ? MAX_LOCAL_PROFILE_RESTORE_BYTES : MAX_LOCAL_API_BODY_BYTES;
  if (Number(lengthHeader) > maximumBytes) {
    return { ok: false, status: 413, code: "payload-too-large" };
  }
  return { ok: true };
}
