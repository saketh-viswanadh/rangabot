import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { buildBookWelcomeResponse } from "../lib/knowledge-welcome.ts";
import { welcomeModes } from "../lib/welcome-preferences.ts";

const page = readFileSync("app/page.tsx", "utf8");
const preferences = readFileSync("app/components/welcome-preferences.tsx", "utf8");
const styles = readFileSync("app/globals.css", "utf8");
const masteryPage = readFileSync("app/mastery/page.tsx", "utf8");
const masteryStyles = readFileSync("app/mastery/mastery.css", "utf8");
const pageAst = ts.createSourceFile("app/page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function findNamedFunction(name: string) {
  let match: ts.FunctionDeclaration | undefined;
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) match = node;
    if (!match) ts.forEachChild(node, visit);
  }
  visit(pageAst);
  assert.ok(match, `Missing ${name} function`);
  return match;
}

function findNamedVariable(name: string) {
  let match: ts.VariableDeclaration | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) match = node;
    if (!match) ts.forEachChild(node, visit);
  }
  visit(pageAst);
  assert.ok(match, `Missing ${name} variable`);
  return match;
}

function fetchCallsWithin(node: ts.Node) {
  const calls: ts.CallExpression[] = [];
  function visit(child: ts.Node) {
    if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === "fetch") calls.push(child);
    ts.forEachChild(child, visit);
  }
  visit(node);
  return calls;
}

function countMatches(source: string, pattern: RegExp) {
  return [...source.matchAll(pattern)].length;
}

function sliceBetween(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing start marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `Missing end marker after ${start}: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("offers optional local personalization and every approved fresh-chat content mode", () => {
  assert.deepEqual([...welcomeModes], ["mixed", "quotes", "jokes", "thoughts", "books"]);
  assert.match(preferences, /Name or nickname/);
  assert.match(preferences, /autoComplete="nickname"/);
  assert.match(preferences, /welcomeModeOptions\.map/);
  assert.match(preferences, /stays in this browser/);
  assert.match(page, /<WelcomePreferencesDialog/);
  assert.match(page, /formatWelcomeGreeting\(greetingIndex, welcomePreferences\.preferredName/);
});

test("keeps the fresh-chat composition compact, passive and intentional", () => {
  const welcome = sliceBetween(page, '<section className="welcome-state"', "{messages.map");
  const starters = sliceBetween(welcome, '<div className="starter-grid"', "</div>");

  assert.equal(countMatches(welcome, /className="welcome-intro"/g), 1, "Fresh chat needs one compact intro");
  assert.equal(countMatches(welcome, /className=\{`welcome-note/g), 1, "Fresh chat needs one welcome note");
  assert.doesNotMatch(welcome, /welcome-kicker|personalize-welcome|welcome-modes/);
  assert.doesNotMatch(styles, /\.welcome-kicker\b|\.personalize-welcome\b|\.welcome-modes\b/);

  assert.doesNotMatch(welcome, /<select\b|welcomeModeOptions|selectWelcomeMode|welcome-mode-select/,
    "Fresh-chat content selection belongs in Preferences, not the welcome card");
  assert.doesNotMatch(welcome, /rotateWelcome|>\s*Another\s*</,
    "The welcome card should read as content, not a control panel");
  assert.doesNotMatch(styles, /\.welcome-note-meta\b|\.welcome-mode-select\b/,
    "Retired inline welcome controls should not leave stale CSS behind");
  assert.match(welcome, /<blockquote>/, "The welcome card should keep one calm content surface");
  assert.match(welcome, /<cite>/, "The welcome card should keep its provenance visible");

  assert.equal(countMatches(starters, /<button\b/g), 4, "Fresh chat keeps exactly four conversation starters");
  assert.equal(countMatches(starters, /<strong>/g), 4, "Every starter exposes one concise title");
  assert.doesNotMatch(starters, /<small>/, "Starter cards must not restore explanatory subtitles");
  assert.doesNotMatch(starters, /name="chevron"/, "Starter cards must not restore decorative chevrons");
});

test("keeps fresh-chat content mode exclusively in the local Preferences dialog", () => {
  const welcome = sliceBetween(page, '<section className="welcome-state"', "{messages.map");

  assert.match(preferences, /<fieldset>/);
  assert.match(preferences, /<legend>What should appear on a fresh chat\?<\/legend>/);
  assert.match(preferences, /welcomeModeOptions\.map/);
  assert.match(preferences, /type="radio"/);
  assert.match(preferences, /name="welcome-mode"/);
  assert.doesNotMatch(welcome, /Fresh chat content|Quotes only|Jokes only|Thoughts only|Facts from my books/);
});

test("separates appearance mode from accessible, visually unlabeled colour swatches", () => {
  const appearance = sliceBetween(page, 'className="tool-appearance"', "</section>");

  assert.match(appearance, /role="group"\s+aria-label="Appearance mode"/);
  assert.match(appearance, /\[(?:"system",\s*)?"light",\s*"dark"\]/,
    "Mode control must expose explicit Light and Dark choices; System is optional");
  assert.match(appearance, /aria-pressed=\{appearance === choice\}/);
  assert.doesNotMatch(appearance, /changeAppearance\(appearance ===/,
    "Light and dark must be explicit choices rather than one ambiguous toggle");

  assert.match(appearance, /role="radiogroup"\s+aria-label="Colour theme"/);
  assert.match(appearance, /role="radio"/);
  assert.match(appearance, /aria-checked=\{palette === choice\.id\}/);
  assert.match(appearance, /aria-label=\{`Use \$\{choice\.label\} colour theme`\}/);
  assert.doesNotMatch(appearance, /<button[^>]+className=\{`palette-choice[^>]*>[\s\S]*?\{choice\.label\}/,
    "Colour names should remain accessible without becoming visible button copy");
});

test("makes Rangabot the default theme and offers several optional colour directions", () => {
  const paletteType = page.match(/type Palette\s*=\s*([^;]+);/);
  assert.ok(paletteType, "Missing Palette type");
  const paletteIds = [...paletteType[1].matchAll(/"([a-z][a-z-]*)"/g)].map((match) => match[1]);

  assert.match(paletteIds[0] ?? "", /^ranga(?:bot)?$/, "Rangabot should be the first and canonical palette");
  assert.ok(paletteIds.length >= 4, "Offer Rangabot plus at least three curated optional palettes");
  assert.equal(new Set(paletteIds).size, paletteIds.length, "Palette IDs must be unique");
  const canonicalPalette = paletteIds[0];
  assert.match(page, new RegExp(`useState<Palette>\\("${canonicalPalette}"\\)`));
  assert.match(page, new RegExp(`setPalette\\("${canonicalPalette}"\\)`),
    "Public demos should also exercise the canonical Rangabot theme");

  for (const palette of paletteIds) {
    assert.match(styles, new RegExp(`\\.app-shell\\[data-palette="${palette}"\\]\\[data-appearance="light"\\]`));
    assert.match(styles, new RegExp(`\\.app-shell\\[data-palette="${palette}"\\]\\[data-appearance="dark"\\]`));
  }
});

test("keeps the Tools appearance toolkit aligned as two intentional control groups", () => {
  assert.match(styles, /\.tool-appearance\s*\{[^}]*display:\s*grid;/);
  assert.match(styles, /\.appearance-controls\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:/);
  assert.match(styles, /\.appearance-mode\s*\{[^}]*display:\s*(?:grid|inline-grid);/);
  assert.match(styles, /\.palette-options\s*\{[^}]*display:\s*flex;/);
  assert.match(styles, /\.palette-choice\[aria-checked="true"\]\s*\{[^}]*(?:outline|box-shadow|border-color):/,
    "Selected swatches need a non-colour-only visual marker");
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*?\.appearance-controls\s*\{[^}]*grid-template-columns:\s*1fr;/,
    "Narrow Tools layouts should stack the two groups instead of wrapping arbitrary pills");
});

test("keeps the empty-chat composer to one compact row", () => {
  const composer = sliceBetween(page, '<div className={`composer-wrap', "</form>");

  assert.match(composer, /messages\.length === 0\s*\?\s*"empty-chat"\s*:\s*""/);
  assert.match(composer, /className="composer-main-row"/);
  assert.match(composer, /<textarea[\s\S]*?rows=\{1\}/);
  assert.equal(countMatches(composer, /className="composer-main-row"/g), 1);
});

test("never places welcome preferences or a preferred name in chat request payloads", () => {
  const requests = fetchCallsWithin(findNamedFunction("sendMessage"));
  const requestText = requests.map((call) => call.getText(pageAst)).join("\n");
  assert.match(requestText, /fetch\("\/api\/chat"/);
  assert.match(requestText, /body:\s*JSON\.stringify/);
  assert.doesNotMatch(requestText, /welcomePreferences|preferredName|welcomeMode|WELCOME_PREFERENCES_STORAGE_KEY|nickname/i);
});

test("loads book welcome facts only from the same-origin no-store endpoint", async () => {
  const request = fetchCallsWithin(findNamedVariable("refreshBookWelcome"))[0];
  assert.ok(request, "Missing book welcome request");
  const requestText = request.getText(pageAst);
  assert.match(requestText, /fetch\(`\/api\/knowledge\/welcome/);
  assert.match(requestText, /cache:\s*"no-store"/);
  assert.doesNotMatch(requestText, /https?:\/\//);

  const response = buildBookWelcomeResponse(
    new Request("http://127.0.0.1/api/knowledge/welcome"),
    { databasePath: resolve(process.cwd(), ".missing-welcome-ui-test.sqlite") },
  );
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
});

test("keeps maintained public demo captures isolated from private local UI state", () => {
  assert.match(page, /const PUBLIC_DEMO_MODES = new Set\(\["knowledge", "welcome"\]\)/);
  assert.match(page, /publicDemo\s*\?\s*\{ \.\.\.defaultWelcomePreferences \}/);
  assert.match(page, /if \(!publicDemo\)\s*\{[\s\S]*?void refreshProjects\(\);\s*void refreshRepositories\(\);\s*void refreshKnowledge\(\);/);
  assert.match(page, /PUBLIC_DEMO_MODES\.has\([^)]*get\("demo"\)[^)]*\)[\s\S]*setConversations\(\[\]\);\s*return;/);

  const welcomeDemo = sliceBetween(
    page,
    'if (parameters.get("demo") === "welcome")',
    'if (parameters.get("demo") !== "knowledge")',
  );
  assert.match(welcomeDemo, /setPalette\("ranga(?:bot)?"\)/);
});

test("does not pull a fresh empty chat down to the bottom anchor", () => {
  assert.match(page, /if \(messages\.length > 0 && followLatestRef\.current\) endRef\.current\?\.scrollIntoView/);
});

test("keeps retired decorative motion and the mastery marketing banner out of runtime UI", () => {
  for (const [surface, source] of [
    ["chat page", page],
    ["chat styles", styles],
    ["mastery page", masteryPage],
    ["mastery styles", masteryStyles],
  ]) {
    assert.doesNotMatch(source, /\b(?:butterfl(?:y|ies)|rainbow|mastery[-_]?banner)\b/i, `${surface} restored a retired UI element`);
  }
});
