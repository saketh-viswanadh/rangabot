import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  currentLocalProfileId,
  initializeLocalProfileSessionContext,
  isLegacyLocalProfileContext,
  localApiFetch,
  profileScopedStorageKey,
} from "../lib/local-api-client.ts";
import {
  LOCAL_PROFILE_CONTEXT_HEADER,
  LOCAL_SESSION_HEADER,
} from "../lib/local-http-security.ts";

const page = readFileSync("app/page.tsx", "utf8");
const manager = readFileSync("app/components/profile-manager.tsx", "utf8");
const memoryPanel = readFileSync("app/components/memory-panel.tsx", "utf8");
const markdown = readFileSync("components/MarkdownMessage.tsx", "utf8");
const styles = readFileSync("app/globals.css", "utf8");

function unsignedClientSession(context: string) {
  return `v1.${Buffer.from(context, "utf8").toString("base64url")}.synthetic-signature`;
}

test("scopes ephemeral renderer state by stable profile identity", () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: `rangabot_session=${unsignedClientSession("1c649efa-1dc0-4c81-887a-e69bfef570a1:27")}` },
  });
  values.set("rangabot-profile-session-context-v1", "1c649efa-1dc0-4c81-887a-e69bfef570a1:27");
  assert.equal(currentLocalProfileId(), "1c649efa-1dc0-4c81-887a-e69bfef570a1");
  assert.equal(isLegacyLocalProfileContext(), false);
  assert.equal(
    profileScopedStorageKey("rangabot-knowledge-read"),
    "rangabot-knowledge-read:profile:1c649efa-1dc0-4c81-887a-e69bfef570a1",
  );
  values.set("rangabot-profile-session-context-v1", "legacy:0");
  document.cookie = `rangabot_session=${unsignedClientSession("legacy:0")}`;
  initializeLocalProfileSessionContext();
  assert.equal(isLegacyLocalProfileContext(), true);
  assert.equal(profileScopedStorageKey("rangabot-knowledge-read"), "rangabot-knowledge-read");
});

test("binds all guarded requests to the active profile context", async () => {
  const values = new Map([["rangabot-profile-session-context-v1", "1c649efa-1dc0-4c81-887a-e69bfef570a1:27"]]);
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: `rangabot_session=${unsignedClientSession("1c649efa-1dc0-4c81-887a-e69bfef570a1:27")}` },
  });
  initializeLocalProfileSessionContext();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "http://127.0.0.1:43123" } } });
  let observed: RequestInit | undefined;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (_input: RequestInfo | URL, init?: RequestInit) => {
      observed = init;
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  await localApiFetch("/api/private", { method: "POST" });
  const headers = new Headers(observed?.headers);
  assert.equal(headers.get(LOCAL_PROFILE_CONTEXT_HEADER), "1c649efa-1dc0-4c81-887a-e69bfef570a1:27");
  assert.equal(headers.get(LOCAL_SESSION_HEADER), unsignedClientSession("1c649efa-1dc0-4c81-887a-e69bfef570a1:27"));
});

test("a new document replaces stale session storage from the newly issued profile cookie", () => {
  const values = new Map([["rangabot-profile-session-context-v1", "1c649efa-1dc0-4c81-887a-e69bfef570a1:27"]]);
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  document.cookie = `rangabot_session=${unsignedClientSession("20000000-0000-4000-8000-000000000002:28")}`;

  assert.equal(initializeLocalProfileSessionContext(), "20000000-0000-4000-8000-000000000002:28");
  assert.equal(values.get("rangabot-profile-session-context-v1"), "20000000-0000-4000-8000-000000000002:28");
  assert.equal(currentLocalProfileId(), "20000000-0000-4000-8000-000000000002");
});

test("keeps the active profile visible and blocks chat admission during switching", () => {
  assert.match(page, /<ProfileManager onSwitchingChange=\{setProfileSwitching\}/);
  assert.match(manager, /Active: <strong>\{marker\}<\/strong>/);
  assert.match(manager, /window\.location\.reload\(\)/);
  assert.match(manager, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(manager, /recoveryRequired\?: boolean/);
  assert.match(manager, /Profile Recovery required/);
  assert.match(manager, /Recover validated profile state/);
  assert.match(manager, /Normal workspace access stays blocked/);
  assert.match(manager, /!\(view\?\.recoveryRequired \|\| view\?\.registryRecoveryRequired\)/);
  assert.match(manager, /view\.profileTransferAllowed/);
  assert.match(manager, /Backup and restore file access is disabled in this sealed verification build/);
  assert.match(page, /disabled=\{profileWorkspaceBlocked\}/);
  assert.match(page, /conversationLoading \|\| profileWorkspaceBlocked/);
  assert.match(page, /profileWorkspaceBlocked = profileSwitching \|\| profileRecoveryRequired/);
  assert.match(page, /Normal workspace access is paused/);
  assert.match(page, /onRecoveryRequiredChange=\{setProfileRecoveryRequired\}/);
  assert.match(manager, /window\.location\.reload\(\)/);
  assert.match(manager, /confirmationRef\.current\?\.focus/);
  assert.match(manager, /role="region" aria-live="assertive"/);
  assert.match(manager, /showSaveFilePicker/);
  assert.doesNotMatch(manager, /anchor\.click\(\)/);
  assert.ok((manager.match(/setRenameName\(""\)/g) ?? []).length >= 4);
  assert.match(styles, /\.profile-trigger/);
  assert.match(styles, /\.profile-dialog/);
  assert.match(styles, /max-height: calc\(100dvh - 36px\)/);
  assert.match(styles, /overflow-y: auto/);
  assert.match(styles, /position: sticky/);
  assert.match(styles, /@media \(max-height: 620px\)/);
  assert.match(styles, /place-items: start center/);
  assert.doesNotMatch(styles, /\.profile-trigger span \{ position: absolute/);
});

test("rotates the browser profile receipt after every registry generation mutation", () => {
  assert.equal((manager.match(/adoptLocalProfileSession\(response\)/g) ?? []).length, 7);
  assert.match(manager, /Set up your protected Default profile/);
  assert.match(manager, /Testing · Temporary/);
  assert.match(manager, /Enter the exact profile name to confirm/);
});

test("routes protected downloads through the guarded profile client", () => {
  for (const [name, source] of [["page", page], ["memory", memoryPanel], ["markdown", markdown]] as const) {
    assert.doesNotMatch(source, /<a[^>]+href=(?:"|\{`)\/api\//, `${name} must not navigate directly to a protected API`);
  }
  assert.match(page, /downloadLocalApiFile\(`\/api\/conversations\//);
  assert.match(page, /localApiBlob\(`\/api\/artifacts\/word\//);
  assert.match(memoryPanel, /downloadLocalApiFile\("\/api\/memories\/export"/);
  assert.match(markdown, /href\?\.startsWith\("\/api\/"\)/);
  assert.match(markdown, /downloadLocalApiFile\(path/);
});

test("keeps legacy durable preferences import-only and profile-gated", () => {
  assert.match(page, /if \(!isLegacyLocalProfileContext\(\)\) return null/);
  for (const key of ["WELCOME_HISTORY_STORAGE_KEY", "BOOK_WELCOME_HISTORY_STORAGE_KEY", '"rangabot-knowledge-read"']) {
    assert.match(page, new RegExp(`profileScopedStorageKey\\(${key}`));
  }
});
