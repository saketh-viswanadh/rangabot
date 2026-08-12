import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DESKTOP_PREFERENCES_MAX_BYTES,
  DESKTOP_PREFERENCES_SCHEMA_VERSION,
  DESKTOP_RENDERER_STORAGE_INVENTORY,
  DesktopPreferencesConflictError,
  DesktopPreferencesPayloadTooLargeError,
  importLegacyDesktopPreferences,
  readDesktopPreferences,
  readDesktopPreferencesMutation,
  updateDesktopPreferences,
} from "../lib/desktop-preferences.ts";
import { WELCOME_HISTORY_STORAGE_KEY } from "../lib/welcome-content.ts";

const firstUpdate = {
  expectedRevision: 0,
  preferredName: "Ranga",
  welcomeMode: "thoughts",
  appearance: "dark",
  palette: "moss",
} as const;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rangabot-desktop-preferences-"));
  const path = join(root, "desktop-preferences.json");
  return { root, path };
}

function request(value: unknown, headers: Record<string, string> = {}) {
  return new Request("http://127.0.0.1/api/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof value === "string" ? value : JSON.stringify(value),
  });
}

test("uses an exact versioned DATA_ROOT schema and safe defaults", () => {
  const { root, path } = fixture();
  try {
    assert.deepEqual(readDesktopPreferences(path), {
      schemaVersion: DESKTOP_PREFERENCES_SCHEMA_VERSION,
      preferredName: "",
      welcomeMode: "mixed",
      appearance: null,
      palette: "rangabot",
      revision: 0,
      updatedAt: null,
      import: null,
    });
    const saved = updateDesktopPreferences(firstUpdate, {
      path,
      trustedDataRoot: root,
      now: "2026-08-12T00:00:00.000Z",
    });
    assert.equal(saved.revision, 1);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, "utf8"))).sort(), [
      "appearance", "import", "palette", "preferredName", "revision", "schemaVersion", "updatedAt", "welcomeMode",
    ]);
    assert.deepEqual(readDesktopPreferences(path), saved);
    if (process.platform !== "win32") assert.equal(lstatSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(root), ["desktop-preferences.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strictly validates preference content instead of silently defaulting or truncating", () => {
  const { root, path } = fixture();
  try {
    for (const invalid of [
      { ...firstUpdate, preferredName: "  Ranga" },
      { ...firstUpdate, preferredName: "x".repeat(41) },
      { ...firstUpdate, welcomeMode: "news" },
      { ...firstUpdate, appearance: "system" },
      { ...firstUpdate, palette: "legacy-sand" },
      { ...firstUpdate, expectedRevision: -1 },
    ]) {
      assert.throws(
        () => updateDesktopPreferences(invalid, { path, trustedDataRoot: root }),
        /invalid|canonical|revision/,
      );
      assert.equal(existsSync(path), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale and concurrent-equivalent writes cannot overwrite a newer revision", async () => {
  const { root, path } = fixture();
  try {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => updateDesktopPreferences(firstUpdate, {
        path, trustedDataRoot: root, now: "2026-08-12T00:00:00.000Z",
      })),
      Promise.resolve().then(() => updateDesktopPreferences({ ...firstUpdate, palette: "plum" }, {
        path, trustedDataRoot: root, now: "2026-08-12T00:00:01.000Z",
      })),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.ok(rejected?.reason instanceof DesktopPreferencesConflictError);
    assert.equal(readDesktopPreferences(path).revision, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed atomic write leaves the prior preferences intact", () => {
  const { root, path } = fixture();
  const unrelatedRoot = mkdtempSync(join(tmpdir(), "rangabot-untrusted-preferences-"));
  try {
    const saved = updateDesktopPreferences(firstUpdate, {
      path, trustedDataRoot: root, now: "2026-08-12T00:00:00.000Z",
    });
    assert.throws(
      () => updateDesktopPreferences({ ...firstUpdate, expectedRevision: 1, palette: "plum" }, {
        path, trustedDataRoot: unrelatedRoot, now: "2026-08-12T00:00:01.000Z",
      }),
      /outside Rangabot|trusted root/,
    );
    assert.deepEqual(readDesktopPreferences(path), saved);
    assert.deepEqual(readdirSync(root), ["desktop-preferences.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(unrelatedRoot, { recursive: true, force: true });
  }
});

test("rejects malformed, oversized, public, and symbolic-link preference files", { skip: process.platform === "win32" }, () => {
  const { root, path } = fixture();
  const external = join(root, "external.json");
  try {
    writeFileSync(path, "{}\n", { mode: 0o600 });
    assert.throws(() => readDesktopPreferences(path), /incompatible schema/);
    writeFileSync(path, "x".repeat(DESKTOP_PREFERENCES_MAX_BYTES + 1), { mode: 0o600 });
    assert.throws(() => readDesktopPreferences(path), /bounded regular private file/);
    writeFileSync(path, JSON.stringify({}), { mode: 0o600 });
    chmodSync(path, 0o644);
    assert.throws(() => readDesktopPreferences(path), /owner-private/);
    rmSync(path);
    writeFileSync(external, "{}\n", { mode: 0o600 });
    symlinkSync(external, path);
    assert.throws(() => readDesktopPreferences(path), /bounded regular private file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy import is explicit, provenance-only, idempotent, and existing desktop values win", async () => {
  const { root, path } = fixture();
  try {
    await assert.rejects(
      readDesktopPreferencesMutation(request({ confirmed: false, ...firstUpdate }), { requireConfirmedImport: true }),
      /incompatible schema/,
    );
    const confirmed = await readDesktopPreferencesMutation(
      request({ confirmed: true, ...firstUpdate }),
      { requireConfirmedImport: true },
    );
    const imported = importLegacyDesktopPreferences(confirmed, {
      path, trustedDataRoot: root, now: "2026-08-12T00:00:00.000Z",
    });
    assert.equal(imported.kind, "imported");
    assert.deepEqual(imported.preferences.import, {
      source: "legacy-loopback-manual",
      importedAt: "2026-08-12T00:00:00.000Z",
    });
    const replay = importLegacyDesktopPreferences({ ...firstUpdate, palette: "plum" }, {
      path, trustedDataRoot: root, now: "2026-08-12T00:00:01.000Z",
    });
    assert.equal(replay.kind, "existing-wins");
    assert.deepEqual(replay.preferences, imported.preferences);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mutation requests are exact JSON and byte-bounded before parsing", async () => {
  assert.deepEqual(await readDesktopPreferencesMutation(request(firstUpdate)), firstUpdate);
  await assert.rejects(readDesktopPreferencesMutation(request({ ...firstUpdate, extra: true })), /incompatible schema/);
  await assert.rejects(
    readDesktopPreferencesMutation(request(firstUpdate, { "Content-Type": "text/plain" })),
    /must use JSON/,
  );
  await assert.rejects(
    readDesktopPreferencesMutation(request("x".repeat(DESKTOP_PREFERENCES_MAX_BYTES + 1))),
    DesktopPreferencesPayloadTooLargeError,
  );
  await assert.rejects(
    readDesktopPreferencesMutation(request(firstUpdate, { "Content-Length": String(DESKTOP_PREFERENCES_MAX_BYTES + 1) })),
    DesktopPreferencesPayloadTooLargeError,
  );
});

test("inventory keeps only four durable values server-side and UI history browser-local", () => {
  assert.deepEqual(DESKTOP_RENDERER_STORAGE_INVENTORY, {
    legacyDurableImportOnly: [
      "rangabot-welcome-preferences-v1",
      "rangabot-appearance",
      "rangabot-palette",
    ],
    ephemeralUiState: [
      WELCOME_HISTORY_STORAGE_KEY,
      "rangabot-book-welcome-history-v1",
      "rangabot-knowledge-read",
    ],
  });
  const page = readFileSync("app/page.tsx", "utf8");
  for (const key of DESKTOP_RENDERER_STORAGE_INVENTORY.legacyDurableImportOnly) {
    assert.doesNotMatch(page, new RegExp(`localStorage\\.setItem\\([^\\n]*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  }
  assert.doesNotMatch(page, /localStorage\.setItem\((WELCOME_PREFERENCES_STORAGE_KEY|APPEARANCE_STORAGE_KEY|PALETTE_STORAGE_KEY)/);
  assert.match(page, /readSameOriginLegacyPreferencePreview/);
  assert.match(page, /window\.confirm/);
  assert.match(page, /confirmed: true/);
  assert.match(page, /method: "POST"/);
  assert.match(page, /setWelcomePreferences\(rollback\.preferences\)/);
  assert.match(page, /No browser preferences were applied/);
  assert.match(page, /different local origin: MISSING/);
  assert.match(page, /does not scan old browser origins/);
  assert.match(page, /use Preferences to re-enter them manually/);
});
