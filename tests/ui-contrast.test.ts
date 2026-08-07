import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync("app/globals.css", "utf8");

function escapeRegularExpression(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function colorTokens(selector: string) {
  const match = styles.match(new RegExp(`${escapeRegularExpression(selector)}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `Missing CSS token scope: ${selector}`);
  return Object.fromEntries(
    [...match[1].matchAll(/--([a-z-]+)\s*:\s*(#[\da-f]{6})\b/gi)]
      .map((entry) => [entry[1], entry[2].toLowerCase()]),
  );
}

function relativeLuminance(hex: string) {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
}

function contrastRatio(first: string, second: string) {
  const luminances = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (luminances[0] + 0.05) / (luminances[1] + 0.05);
}

test("keeps every light palette's bubbles and accent controls at WCAG AA contrast", () => {
  const root = colorTokens(":root");
  const light = colorTokens('.app-shell[data-appearance="light"]');
  const paletteScopes = {
    sand: {},
    sage: colorTokens('.app-shell[data-palette="sage"][data-appearance="light"]'),
    lavender: colorTokens('.app-shell[data-palette="lavender"][data-appearance="light"]'),
  };

  assert.match(styles, /\.message\.user \.message-body\s*\{[^}]*background:\s*var\(--user-bubble\);[^}]*color:\s*var\(--on-user\);/);
  assert.match(styles, /\.welcome-modes button\.selected\s*\{[^}]*color:\s*var\(--on-accent\);[^}]*background:\s*var\(--accent\);/);

  for (const [palette, overrides] of Object.entries(paletteScopes)) {
    const tokens = { ...root, ...light, ...overrides };
    for (const [foreground, background] of [
      ["on-user", "user-bubble"],
      ["on-accent", "user-bubble"],
      ["on-accent", "accent"],
    ] as const) {
      assert.ok(tokens[foreground], `${palette} is missing --${foreground}`);
      assert.ok(tokens[background], `${palette} is missing --${background}`);
      const ratio = contrastRatio(tokens[foreground], tokens[background]);
      assert.ok(ratio >= 4.5, `${palette} --${foreground} on --${background} is ${ratio.toFixed(2)}:1; expected at least 4.5:1`);
    }
  }
});
