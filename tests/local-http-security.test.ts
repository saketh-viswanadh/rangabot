import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  bindLocalRequestUrlToValidatedHost,
  evaluateLocalBootstrapRequest,
  evaluateLocalApiRequest,
  isAllowedLocalApiUrl,
  isAllowedLoopbackHost,
  LOCAL_BOOTSTRAP_PATH,
  LOCAL_SESSION_HEADER,
} from "../lib/local-http-security.ts";

const token = `${"a".repeat(43)}.${"b".repeat(43)}`;

function evaluate(options: {
  url?: string;
  method?: string;
  host?: string;
  origin?: string;
  fetchSite?: string;
  sessionCookie?: string;
  suppliedToken?: string;
  contentType?: string;
  contentLength?: string;
  contentEncoding?: string;
} = {}) {
  const headers = new Headers({ host: options.host ?? "127.0.0.1:3000" });
  if (options.origin !== undefined) headers.set("origin", options.origin);
  if (options.fetchSite !== undefined) headers.set("sec-fetch-site", options.fetchSite);
  if (options.suppliedToken !== undefined) headers.set(LOCAL_SESSION_HEADER, options.suppliedToken);
  if (options.contentType !== undefined) headers.set("content-type", options.contentType);
  const method = options.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") headers.set("content-length", options.contentLength ?? "2");
  if (options.contentEncoding !== undefined) headers.set("content-encoding", options.contentEncoding);
  return evaluateLocalApiRequest({
    url: options.url ?? "http://127.0.0.1:3000/api/status",
    method,
    headers,
    sessionCookie: options.sessionCookie ?? token,
    issuedSessionValid: options.sessionCookie === undefined || options.sessionCookie === token,
  });
}

test("accepts only explicit loopback Host values", () => {
  for (const host of ["127.0.0.1", "127.0.0.1:3000", "localhost", "localhost:3000", "[::1]:3000"]) {
    assert.equal(isAllowedLoopbackHost(host), true, host);
  }
  for (const host of [null, "", "rangabot.com", "127.0.0.1.example.com", "127.0.0.1@evil.test", "127.0.0.1/path", "localhost evil.test"]) {
    assert.equal(isAllowedLoopbackHost(host), false, String(host));
  }
});

test("restores a validated numeric-loopback Host after NextRequest normalizes its URL", () => {
  assert.equal(
    bindLocalRequestUrlToValidatedHost(
      "http://localhost:43127/api/local-session/desktop-readiness",
      "127.0.0.1:43127",
    ),
    "http://127.0.0.1:43127/api/local-session/desktop-readiness",
  );
  assert.equal(
    bindLocalRequestUrlToValidatedHost("http://localhost:43127/api/status?view=compact", "localhost:43127"),
    "http://localhost:43127/api/status?view=compact",
  );
  for (const host of [null, "evil.test:43127", "127.0.0.1@evil.test", "127.0.0.1/path"]) {
    assert.equal(bindLocalRequestUrlToValidatedHost("http://localhost:43127/api/status", host), null);
  }
  assert.equal(bindLocalRequestUrlToValidatedHost("https://localhost:43127/api/status", "127.0.0.1:43127"), null);
  assert.equal(
    bindLocalRequestUrlToValidatedHost("http://localhost:43127//evil.test/api/status", "127.0.0.1:43127"),
    "http://127.0.0.1:43127//evil.test/api/status",
  );
});

test("allows the client helper to target only the current local API", () => {
  assert.equal(isAllowedLocalApiUrl("/api/status", "http://127.0.0.1:3000"), true);
  assert.equal(isAllowedLocalApiUrl("http://127.0.0.1:3000/api/status", "http://127.0.0.1:3000"), true);
  assert.equal(isAllowedLocalApiUrl("//evil.test/api/status", "http://127.0.0.1:3000"), false);
  assert.equal(isAllowedLocalApiUrl("https://evil.test/api/status", "http://127.0.0.1:3000"), false);
  assert.equal(isAllowedLocalApiUrl("/not-api", "http://127.0.0.1:3000"), false);
});

test("allows a same-origin read only with its local session cookie", () => {
  assert.deepEqual(evaluate({ fetchSite: "same-origin" }), { ok: true });
  assert.deepEqual(evaluate({ origin: "http://127.0.0.1:3000" }), { ok: true });
  assert.equal(evaluate({ sessionCookie: undefined }).ok, true, "the helper supplies a default token");
  assert.deepEqual(evaluateLocalApiRequest({
    url: "http://127.0.0.1:3000/api/status",
    method: "GET",
    headers: new Headers({ host: "127.0.0.1:3000" }),
    issuedSessionValid: false,
  }), { ok: false, status: 403, code: "forbidden" });
});

test("mints a browser session only through the exact same-origin bootstrap request", () => {
  const headers = new Headers({
    host: "127.0.0.1:3000",
    origin: "http://127.0.0.1:3000",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    "content-length": "2",
  });
  const valid = {
    url: `http://127.0.0.1:3000${LOCAL_BOOTSTRAP_PATH}`,
    method: "POST",
    headers,
    bootstrapTokenValid: true,
  };
  assert.deepEqual(evaluateLocalBootstrapRequest(valid), { ok: true });
  assert.equal(evaluateLocalBootstrapRequest({ ...valid, bootstrapTokenValid: false }).ok, false);
  assert.equal(evaluateLocalBootstrapRequest({ ...valid, method: "GET" }).ok, false);
  assert.equal(evaluateLocalBootstrapRequest({ ...valid, url: `${valid.url}?bootstrap=secret` }).ok, false);
  assert.equal(evaluateLocalBootstrapRequest({ ...valid, headers: new Headers({ ...Object.fromEntries(headers), origin: "https://evil.test" }) }).ok, false);
  assert.equal(evaluateLocalBootstrapRequest({ ...valid, headers: new Headers({ ...Object.fromEntries(headers), "sec-fetch-site": "cross-site" }) }).ok, false);
  assert.equal(evaluateLocalBootstrapRequest({ ...valid, headers: new Headers({ ...Object.fromEntries(headers), "content-length": "65" }) }).ok, false);
});

test("rejects DNS rebinding and cross-origin browser requests", () => {
  assert.equal(evaluate({ host: "evil.test" }).ok, false);
  assert.equal(evaluate({ url: "http://evil.test/api/status" }).ok, false);
  assert.equal(evaluate({ origin: "https://evil.test" }).ok, false);
  assert.equal(evaluate({ origin: "null" }).ok, false);
  assert.equal(evaluate({ fetchSite: "cross-site" }).ok, false);
  assert.equal(evaluate({ fetchSite: "same-site" }).ok, false);
});

test("requires matching capability and JSON for every mutation", () => {
  const valid = evaluate({
    method: "POST",
    origin: "http://127.0.0.1:3000",
    fetchSite: "same-origin",
    suppliedToken: token,
    contentType: "application/json; charset=utf-8",
  });
  assert.deepEqual(valid, { ok: true });
  assert.deepEqual(evaluate({ method: "DELETE", suppliedToken: token, contentType: "application/json" }), { ok: true });
  assert.deepEqual(evaluate({ method: "POST", contentType: "application/json" }), { ok: false, status: 403, code: "forbidden" });
  assert.deepEqual(evaluate({ method: "POST", suppliedToken: "a".repeat(32), contentType: "application/json" }), { ok: false, status: 403, code: "forbidden" });
  assert.deepEqual(evaluate({ method: "POST", suppliedToken: token, contentType: "text/plain" }), { ok: false, status: 415, code: "unsupported-media-type" });
  assert.deepEqual(evaluate({ method: "POST", suppliedToken: token }), { ok: false, status: 415, code: "unsupported-media-type" });
  assert.deepEqual(evaluate({ method: "POST", suppliedToken: token, contentType: "application/json", contentLength: "0" }), { ok: false, status: 411, code: "length-required" });
  assert.deepEqual(evaluate({ method: "POST", suppliedToken: token, contentType: "application/json", contentLength: "2200001" }), { ok: false, status: 413, code: "payload-too-large" });
  assert.deepEqual(evaluate({ method: "POST", suppliedToken: token, contentType: "application/json", contentEncoding: "gzip" }), { ok: false, status: 415, code: "unsupported-media-type" });
});

test("wires the guard across all API routes and all browser API calls", () => {
  const proxy = readFileSync("proxy.ts", "utf8");
  assert.match(proxy, /matcher:\s*\["\/api\/:path\*"/);
  assert.match(proxy, /request\.nextUrl\.pathname === LOCAL_BOOTSTRAP_PATH/);
  assert.match(proxy, /request\.nextUrl\.pathname === DESKTOP_READINESS_PATH/);
  assert.match(proxy, /const requestUrl = bindLocalRequestUrlToValidatedHost\(request\.url, host\)/);
  assert.equal((proxy.match(/url: requestUrl/g) ?? []).length, 3);
  assert.match(proxy, /NextResponse\.redirect\(new URL\("\/", requestUrl\), 303\)/);
  assert.match(proxy, /consumeOnce: process\.env\.RANGABOT_DESKTOP === "1"/);
  assert.match(proxy, /bootstrapTokenVerifier\.consume\(suppliedBootstrapToken\)/);
  assert.match(proxy, /if \(!sessionValid\) return forbidden\(false\)/);
  assert.doesNotMatch(proxy, /if \(!verifyLocalSessionToken\(current, sessionSecret\)\)\s*\{\s*response\.cookies\.set/);
  for (const path of ["app/page.tsx", "app/components/memory-panel.tsx", "app/components/sql-analysis-panel.tsx", "app/components/response-feedback.tsx"]) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /\bfetch\(/, `${path} must use the guarded client`);
    assert.match(source, /localApiFetch/);
  }
});

test("keeps the startup capability out of request URLs and browser history", () => {
  const bootstrapPage = readFileSync("app/bootstrap/page.tsx", "utf8");
  for (const scriptPath of ["scripts/start-dev.ts", "scripts/start-server.ts"]) {
    const script = readFileSync(scriptPath, "utf8");
    assert.match(script, /localBootstrapUrl\(bootstrapToken, serverPort\)/);
    assert.match(script, /"--hostname", "127\.0\.0\.1", "--port"/);
  }
  assert.match(bootstrapPage, /window\.location\.hash/);
  assert.match(bootstrapPage, /window\.history\.replaceState/);
  assert.match(bootstrapPage, /window\.location\.replace\("\/"\)/);
  assert.doesNotMatch(bootstrapPage, /console\.(?:log|warn|error)/);
});

test("blocks model-authored remote resources at rendering and policy layers", () => {
  const markdown = readFileSync("components/MarkdownMessage.tsx", "utf8");
  const config = readFileSync("next.config.ts", "utf8");
  assert.match(markdown, /img\(\{ alt \}\)/);
  assert.match(markdown, /Image blocked/);
  assert.match(config, /img-src 'self' data: blob:/);
  assert.match(config, /connect-src 'self'/);
  assert.doesNotMatch(config, /connect-src[^\n]*\sws:\s/);
  assert.doesNotMatch(config, /connect-src[^\n]*\swss:\s/);
  assert.match(config, /object-src 'none'/);
  assert.match(config, /frame-ancestors 'none'/);
});
