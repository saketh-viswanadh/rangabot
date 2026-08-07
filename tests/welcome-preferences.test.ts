import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PREFERRED_NAME_CHARACTERS,
  WELCOME_PREFERENCES_STORAGE_KEY,
  WELCOME_PREFERENCES_VERSION,
  defaultWelcomePreferences,
  parseWelcomePreferences,
  sanitizePreferredName,
  serializeWelcomePreferences,
} from "../lib/welcome-preferences.ts";

test("uses a versioned local-only preference contract with safe defaults", () => {
  assert.equal(WELCOME_PREFERENCES_STORAGE_KEY, "rangabot-welcome-preferences-v1");
  assert.equal(WELCOME_PREFERENCES_VERSION, 1);
  assert.deepEqual(parseWelcomePreferences(null), defaultWelcomePreferences);
  assert.deepEqual(parseWelcomePreferences("not json"), defaultWelcomePreferences);
  assert.deepEqual(parseWelcomePreferences(JSON.stringify({ version: 2, preferredName: "Saketh", mode: "jokes" })), defaultWelcomePreferences);
});

test("parses every supported mode and rejects unknown modes", () => {
  for (const mode of ["mixed", "quotes", "jokes", "thoughts", "books"] as const) {
    assert.deepEqual(parseWelcomePreferences(JSON.stringify({ version: 1, preferredName: "Ranga", mode })), {
      version: 1,
      preferredName: "Ranga",
      mode,
    });
  }
  assert.equal(parseWelcomePreferences(JSON.stringify({ version: 1, preferredName: "Ranga", mode: "news" })).mode, "mixed");
});

test("normalizes optional names without interpreting markup or control characters", () => {
  assert.equal(sanitizePreferredName("  Saketh\n\u202e  Viswanadha  "), "Saketh Viswanadha");
  assert.equal(sanitizePreferredName("<b>Ranga</b> 🐕"), "<b>Ranga</b> 🐕");
  assert.equal(sanitizePreferredName("\u0000\n\t"), null);
  assert.equal(Array.from(sanitizePreferredName("𐍈".repeat(MAX_PREFERRED_NAME_CHARACTERS + 5)) ?? "").length, MAX_PREFERRED_NAME_CHARACTERS);
});

test("serializes only the normalized versioned preference fields", () => {
  assert.equal(
    serializeWelcomePreferences({ preferredName: "  Ranga   Bot ", mode: "thoughts" }),
    JSON.stringify({ version: 1, preferredName: "Ranga Bot", mode: "thoughts" }),
  );
  assert.equal(
    serializeWelcomePreferences({ preferredName: 42, mode: "unsupported" }),
    JSON.stringify(defaultWelcomePreferences),
  );
});
