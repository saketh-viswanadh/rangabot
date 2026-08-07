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

const appearances = ["light", "dark"] as const;

function paletteIds() {
  const matches = [...styles.matchAll(/\.app-shell\[data-palette="([a-z][a-z-]*)"\]\[data-appearance="(?:light|dark)"\]/g)]
    .map((match) => match[1]);
  return [...new Set(matches)];
}

const palettes = paletteIds();

function themeTokens(palette: string, appearance: typeof appearances[number]) {
  const scopes = [
    ":root",
    `.app-shell[data-appearance="${appearance}"]`,
    `.app-shell[data-palette="${palette}"]`,
    `.app-shell[data-palette="${palette}"][data-appearance="${appearance}"]`,
  ];
  return Object.assign({}, ...scopes.map((selector) => {
    const escaped = escapeRegularExpression(selector);
    return new RegExp(`${escaped}\\s*\\{`).test(styles) ? colorTokens(selector) : {};
  }));
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

function linearRgb(hex: string) {
  return [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
}

function oklab(hex: string) {
  const [red, green, blue] = linearRgb(hex);
  const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function perceptualDistance(first: string, second: string) {
  const left = oklab(first);
  const right = oklab(second);
  return Math.hypot(...left.map((channel, index) => channel - right[index]));
}

test("applies the final semantic surface tokens to the visible UI", () => {
  assert.match(styles, /\.app-shell\s*\{[^}]*background(?:-color)?:[^;}]*var\(--canvas\)/);
  assert.match(styles, /\.sidebar\s*\{[^}]*background(?:-color)?:[^;}]*var\(--sidebar-surface\)/);
  assert.match(styles, /\.welcome-note\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/,
    "The fresh-chat welcome should stay passive rather than reading as another settings card");
  assert.match(styles, /\.starter-grid button\s*\{[^}]*background:\s*var\(--starter-surface\)/);
  assert.match(styles, /\.composer\s*\{[^}]*background(?:-color)?:[^;}]*var\(--composer-surface\)/);
  assert.match(styles, /\.message\.user \.message-body\s*\{[^}]*background:\s*var\(--user-bubble\);[^}]*color:\s*var\(--on-user\);/);
});

test("keeps every curated light and dark theme at WCAG AA contrast", () => {
  assert.ok(palettes.some((palette) => /^ranga(?:bot)?$/.test(palette)), "Missing the canonical Rangabot palette");
  assert.ok(palettes.length >= 4, "Expected Rangabot plus at least three optional palettes");
  for (const appearance of appearances) {
    for (const palette of palettes) {
      const tokens = themeTokens(palette, appearance);
      for (const required of [
        "canvas",
        "sidebar-surface",
        "card-surface",
        "composer-surface",
        "surface-raised",
        "starter-surface",
        "assistant-bubble",
        "text",
        "muted",
        "accent",
        "accent-strong",
        "focus",
        "on-accent",
        "user-bubble",
        "on-user",
      ]) {
        assert.ok(tokens[required], `${palette} ${appearance} is missing opaque --${required}`);
      }

      for (const background of ["canvas", "sidebar-surface", "card-surface", "composer-surface", "surface-raised", "starter-surface", "assistant-bubble"] as const) {
        for (const foreground of ["text", "muted"] as const) {
          const ratio = contrastRatio(tokens[foreground], tokens[background]);
          assert.ok(
            ratio >= 4.5,
            `${palette} ${appearance} --${foreground} on --${background} is ${ratio.toFixed(2)}:1; expected WCAG AA 4.5:1`,
          );
        }
      }

      for (const background of ["canvas", "sidebar-surface", "card-surface", "composer-surface"] as const) {
        const ratio = contrastRatio(tokens.focus, tokens[background]);
        assert.ok(
          ratio >= 3,
          `${palette} ${appearance} --focus on --${background} is ${ratio.toFixed(2)}:1; expected 3:1`,
        );
      }

      for (const [foreground, background] of [
        ["on-user", "user-bubble"],
        ["on-accent", "accent"],
      ] as const) {
        const ratio = contrastRatio(tokens[foreground], tokens[background]);
        assert.ok(
          ratio >= 4.5,
          `${palette} ${appearance} --${foreground} on --${background} is ${ratio.toFixed(2)}:1; expected WCAG AA 4.5:1`,
        );
      }
    }
  }
});

test("provides genuinely traditional white and black environments", () => {
  const light = themeTokens("monochrome", "light");
  const dark = themeTokens("monochrome", "dark");

  assert.equal(light.canvas, "#ffffff");
  assert.equal(dark.canvas, "#000000");
  for (const tokens of [light, dark]) {
    for (const token of ["canvas", "canvas-glow", "sidebar-surface", "card-surface", "composer-surface", "surface-raised", "starter-surface"] as const) {
      const [, a, b] = oklab(tokens[token]);
      assert.ok(Math.hypot(a, b) <= 0.012, `Monochrome --${token} has a visible colour cast`);
    }
  }
});

test("keeps Graphite cool-neutral and Cement warm-neutral without becoming tinted themes", () => {
  for (const palette of ["graphite", "cement"] as const) {
    const light = themeTokens(palette, "light");
    const dark = themeTokens(palette, "dark");
    assert.ok(relativeLuminance(light.canvas) >= 0.72 && relativeLuminance(light.canvas) <= 0.88,
      `${palette} light should remain a mid-light neutral environment`);
    assert.ok(relativeLuminance(dark.canvas) >= 0.015 && relativeLuminance(dark.canvas) <= 0.08,
      `${palette} dark should remain a charcoal neutral environment`);
    for (const tokens of [light, dark]) {
      for (const token of ["canvas", "canvas-glow", "sidebar-surface", "card-surface", "composer-surface", "surface-raised", "starter-surface"] as const) {
        const [, a, b] = oklab(tokens[token]);
        assert.ok(Math.hypot(a, b) <= 0.035, `${palette} --${token} is too chromatic for a neutral theme`);
      }
    }
  }
});

test("uses tonal hierarchy inside every theme instead of one flat colour wash", () => {
  const distinctSurfacePairs = [
    ["canvas", "sidebar-surface"],
    ["canvas", "card-surface"],
    ["canvas", "composer-surface"],
  ] as const;

  for (const appearance of appearances) {
    for (const palette of palettes) {
      const tokens = themeTokens(palette, appearance);
      for (const [first, second] of distinctSurfacePairs) {
        assert.ok(tokens[first], `${palette} ${appearance} is missing --${first}`);
        assert.ok(tokens[second], `${palette} ${appearance} is missing --${second}`);
        const distance = perceptualDistance(tokens[first], tokens[second]);
        assert.ok(
          distance >= 0.018,
          `${palette} ${appearance} ${first}/${second} distance is ${distance.toFixed(3)}; expected a visible tonal hierarchy`,
        );
      }
    }
  }
});

test("gives every palette a genuinely different light and dark environment", () => {
  for (const palette of palettes) {
    const light = themeTokens(palette, "light");
    const dark = themeTokens(palette, "dark");
    for (const token of ["canvas", "sidebar-surface", "card-surface", "composer-surface"] as const) {
      assert.ok(light[token], `${palette} light is missing --${token}`);
      assert.ok(dark[token], `${palette} dark is missing --${token}`);
      const distance = perceptualDistance(light[token], dark[token]);
      assert.ok(
        distance >= 0.35,
        `${palette} light/dark --${token} distance is ${distance.toFixed(3)}; expected at least 0.350`,
      );
    }
    assert.ok(
      relativeLuminance(light.canvas) >= 0.72,
      `${palette} light canvas luminance is ${relativeLuminance(light.canvas).toFixed(3)}; expected a true light environment`,
    );
    assert.ok(
      relativeLuminance(dark.canvas) <= 0.08,
      `${palette} dark canvas luminance is ${relativeLuminance(dark.canvas).toFixed(3)}; expected a true dark environment`,
    );
  }
});

test("keeps every palette visibly distinct in light and dark modes", () => {
  const minimumDistance = {
    canvas: 0.025,
    "sidebar-surface": 0.025,
    "card-surface": 0.025,
    "composer-surface": 0.025,
    accent: 0.06,
  } as const;

  for (const appearance of appearances) {
    for (let leftIndex = 0; leftIndex < palettes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < palettes.length; rightIndex += 1) {
        const leftPalette = palettes[leftIndex];
        const rightPalette = palettes[rightIndex];
        const left = themeTokens(leftPalette, appearance);
        const right = themeTokens(rightPalette, appearance);

        for (const [token, threshold] of Object.entries(minimumDistance)) {
          assert.ok(left[token], `${leftPalette} ${appearance} is missing --${token}`);
          assert.ok(right[token], `${rightPalette} ${appearance} is missing --${token}`);
          const distance = perceptualDistance(left[token], right[token]);
          assert.ok(
            distance >= threshold,
            `${appearance} ${leftPalette}/${rightPalette} --${token} distance is ${distance.toFixed(3)}; expected at least ${threshold.toFixed(3)}`,
          );
        }
      }
    }
  }
});
