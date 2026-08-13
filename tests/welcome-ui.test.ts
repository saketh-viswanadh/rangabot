import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { buildBookWelcomeResponse } from "../lib/knowledge-welcome.ts";
import { welcomeModes } from "../lib/welcome-preferences.ts";
import { paletteOptions } from "../lib/appearance-preferences.ts";

function readSource(path: string) {
  return readFileSync(path, "utf8").replace(/\r\n?/g, "\n");
}

const page = readSource("app/page.tsx");
const preferences = readSource("app/components/welcome-preferences.tsx");
const styles = readSource("app/globals.css");
const masteryPage = readSource("app/mastery/page.tsx");
const masteryStyles = readSource("app/mastery/mastery.css");
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

function localApiCallsWithin(node: ts.Node) {
  const calls: ts.CallExpression[] = [];
  function visit(child: ts.Node) {
    if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === "localApiFetch") calls.push(child);
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
  assert.match(preferences, /stay in Rangabot’s private local data on this device/);
  assert.match(page, /<WelcomePreferencesDialog/);
  assert.match(page, /formatWelcomeGreeting\(greetingIndex, welcomePreferences\.preferredName\?\.trim\(\) \|\| activeProfileContext\?\.displayName/,
    "The active profile name should personalize greetings when no separate nickname was saved");
});

test("keeps the fresh-chat composition compact, passive and intentional", () => {
  const welcome = sliceBetween(page, '<section className="welcome-state"', "{messages.map");
  const composer = sliceBetween(page, '<div className={`composer-wrap', "</form>");
  const header = sliceBetween(page, '<header className="chat-header">', "</header>");
  const starters = sliceBetween(composer, '<div className="starter-grid"', "</div>");

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
  assert.match(styles, /\.welcome-inspiration\s*\{\s*display:\s*grid/,
    "The rotating joke, quote, or thought must remain visible");
  assert.match(welcome, /<blockquote>/, "The welcome card should keep one calm content surface");
  assert.match(welcome, /<cite>/, "The welcome card should keep its provenance visible");
  assert.doesNotMatch(composer, /composer-model-status|On this Mac/,
    "Model metadata must not compete with writing inside the composer");
  assert.match(header, /header-model-status/);
  assert.match(header, /On this Mac/);

  assert.equal(countMatches(starters, /<button\b/g), 3, "Fresh chat keeps three quiet conversation starters");
  assert.equal(countMatches(starters, /<strong>/g), 3, "Every starter exposes one concise title");
  assert.doesNotMatch(starters, /<small>/, "Starter cards must not restore explanatory subtitles");
  assert.doesNotMatch(starters, /name="chevron"/, "Starter cards must not restore decorative chevrons");
  assert.ok(page.indexOf('<div className="starter-grid"') > page.indexOf('<div className={`composer-wrap'),
    "Starters should sit immediately with the composer instead of floating in the empty canvas");
});

test("keeps fresh-chat content mode exclusively in the local Preferences dialog", () => {
  const welcome = sliceBetween(page, '<section className="welcome-state"', "{messages.map");

  assert.match(preferences, /<fieldset className="welcome-content-options">/);
  assert.match(preferences, /<legend>What should appear on a fresh chat\?<\/legend>/);
  assert.match(preferences, /welcomeModeOptions\.map/);
  assert.match(preferences, /type="radio"/);
  assert.match(preferences, /name="welcome-mode"/);
  assert.doesNotMatch(welcome, /Fresh chat content|Quotes only|Jokes only|Thoughts only|Facts from my books/);
});

test("keeps appearance in persistent Preferences rather than the local workbench", () => {
  const tools = sliceBetween(page, 'className="tools-menu"', "</div>\n            </div>");

  assert.match(page, /> Settings<\/button>/);
  assert.match(page, /aria-label="Conversation and workspace options"/,
    "The compact workspace menu must retain a programmatic name");
  assert.match(page, /<WelcomePreferencesDialog[\s\S]*?appearance=\{appearance\}[\s\S]*?palette=\{palette\}/);
  assert.doesNotMatch(tools, /tool-appearance|Appearance mode|Colour theme/,
    "Tools should contain capabilities and permissions, not personal appearance settings");
});

test("separates appearance mode from native, visually unlabeled colour radios", () => {
  const appearance = sliceBetween(preferences, 'className="preferences-appearance"', "</section>");

  assert.match(appearance, /role="group"\s+aria-label="Appearance mode"/);
  assert.match(appearance, /\[(?:"system",\s*)?"light",\s*"dark"\]/,
    "Mode control must expose explicit Light and Dark choices; System is optional");
  assert.match(appearance, /aria-pressed=\{draftAppearance === choice\}/);
  assert.doesNotMatch(appearance, /changeAppearance\(appearance ===/,
    "Light and dark must be explicit choices rather than one ambiguous toggle");

  assert.match(appearance, /<fieldset className="palette-options"/);
  assert.match(appearance, /<legend className="sr-only">Colour theme<\/legend>/);
  assert.match(appearance, /type="radio"/);
  assert.match(appearance, /name="colour-theme"/);
  assert.match(appearance, /onKeyDown=\{movePalette\}/);
  assert.match(preferences, /ArrowLeft:[\s\S]*?ArrowRight:[\s\S]*?event\.preventDefault\(\)/,
    "The radio group should provide reliable arrow-key navigation across browser engines");
  assert.match(appearance, /checked=\{draftPalette === choice\.id\}/);
  assert.match(appearance, /onChange=\{\(\) => setDraftPalette\(choice\.id\)\}/);
  assert.match(appearance, /<span className="sr-only">\{choice\.label\}<\/span>/);
  assert.doesNotMatch(appearance, /<label[^>]+className=\{`palette-choice[^>]*>[\s\S]*?<span>(?:\s*)\{choice\.label\}/,
    "Colour names should remain accessible without becoming visible button copy");
});

test("implements a complete keyboard contract for the two Preferences tabs", () => {
  assert.match(preferences, /role="tablist"[\s\S]*?onKeyDown=\{moveSection\}/);
  assert.match(preferences, /role="tab"[\s\S]*?aria-controls="preferences-personal-panel"[\s\S]*?tabIndex=\{activeSection === "personal" \? 0 : -1\}/);
  assert.match(preferences, /role="tab"[\s\S]*?aria-controls="preferences-appearance-panel"[\s\S]*?tabIndex=\{activeSection === "appearance" \? 0 : -1\}/);
  assert.match(preferences, /role="tabpanel" aria-labelledby="preferences-personal-tab"/);
  assert.match(preferences, /role="tabpanel" aria-labelledby="preferences-appearance-tab"/);
  assert.match(preferences, /\["ArrowLeft", "ArrowRight", "Home", "End"\]/);
});

test("makes Rangabot the default theme and offers several optional colour directions", () => {
  const paletteIds = paletteOptions.map(({ id }) => id);

  assert.equal(paletteIds[0], "rangabot", "Rangabot should be the first and canonical palette");
  assert.deepEqual(paletteIds.slice(0, 4), ["rangabot", "monochrome", "graphite", "cement"],
    "The default and neutral family should form one intentional first row");
  assert.equal(paletteIds.length, 8, "Offer a balanced 4 by 2 set without overflow or hidden choices");
  assert.equal(new Set(paletteIds).size, paletteIds.length, "Palette IDs must be unique");
  const canonicalPalette = paletteIds[0];
  assert.match(page, /useState<Palette>\(DEFAULT_PALETTE\)/);
  assert.match(page, new RegExp(`setPalette\\("${canonicalPalette}"\\)`),
    "Public demos should also exercise the canonical Rangabot theme");

  for (const palette of paletteIds) {
    assert.match(styles, new RegExp(`\\.app-shell\\[data-palette="${palette}"\\]\\[data-appearance="light"\\]`));
    assert.match(styles, new RegExp(`\\.app-shell\\[data-palette="${palette}"\\]\\[data-appearance="dark"\\]`));
  }
});

test("keeps Preferences appearance controls aligned and scalable", () => {
  assert.match(styles, /\.preferences-appearance\s*\{[^}]*display:\s*grid;/);
  assert.match(styles, /\.appearance-controls\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:/);
  assert.match(styles, /\.appearance-controls\s*\{[^}]*align-items:\s*start;/);
  assert.match(styles, /\.appearance-mode\s*\{[^}]*display:\s*(?:grid|inline-grid);/);
  assert.match(styles, /\.palette-options\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(4,\s*44px\)/);
  assert.match(styles, /\.palette-choice\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px;/);
  assert.match(styles, /\.palette-choice:has\(input:checked\)\s*\{[^}]*(?:outline|box-shadow|border-color):/,
    "Selected swatches need a non-colour-only visual marker");
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*?\.appearance-controls\s*\{[^}]*grid-template-columns:\s*1fr;/,
    "Narrow Preferences layouts should stack the two groups instead of wrapping arbitrary pills");
  assert.match(styles, /\.welcome-preferences-dialog footer\s*\{[^}]*position:\s*sticky;/,
    "Preference actions must remain reachable on short mobile screens");
});

test("keeps the empty-chat composer to one compact row", () => {
  const composer = sliceBetween(page, '<div className={`composer-wrap', "</form>");

  assert.match(composer, /messages\.length === 0\s*\?\s*"empty-chat"\s*:\s*""/);
  assert.match(composer, /className="composer-main-row"/);
  assert.match(composer, /<textarea[\s\S]*?rows=\{1\}/);
  assert.equal(countMatches(composer, /className="composer-main-row"/g), 1);
  assert.doesNotMatch(composer, /<select|Routing mode|Response mode/,
    "Routing policy belongs with model controls, not inside the writing surface");
  assert.match(page, /className="header-route-control"/);
  assert.match(page, /aria-label="Response mode"/);
  assert.match(composer, /className="composer-submit send-button"/);
  assert.match(composer, /className="composer-submit stop-button"/);
  assert.match(styles, /\.composer-actions \{[^}]*place-items: center/);
  assert.match(styles, /\.composer button \{[^}]*place-items: center/);
});

test("never places welcome preferences or a preferred name in chat request payloads", () => {
  const requests = localApiCallsWithin(findNamedFunction("sendMessage"));
  const requestText = requests.map((call) => call.getText(pageAst)).join("\n");
  assert.match(requestText, /localApiFetch\("\/api\/chat"/);
  assert.match(requestText, /body:\s*JSON\.stringify/);
  assert.doesNotMatch(requestText, /welcomePreferences|preferredName|welcomeMode|WELCOME_PREFERENCES_STORAGE_KEY|nickname/i);
});

test("loads book welcome facts only from the same-origin no-store endpoint", async () => {
  const request = localApiCallsWithin(findNamedVariable("refreshBookWelcome"))[0];
  assert.ok(request, "Missing book welcome request");
  const requestText = request.getText(pageAst);
  assert.match(requestText, /localApiFetch\(`\/api\/knowledge\/welcome/);
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
  assert.match(page, /if \(publicDemo\)\s*\{\s*applyPreferences\(\{ \.\.\.defaultWelcomePreferences \}, null, DEFAULT_PALETTE\);/);
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
