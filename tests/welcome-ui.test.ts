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

test("offers optional local personalization and every approved fresh-chat content mode", () => {
  assert.deepEqual([...welcomeModes], ["mixed", "quotes", "jokes", "thoughts", "books"]);
  assert.match(preferences, /Name or nickname/);
  assert.match(preferences, /autoComplete="nickname"/);
  assert.match(preferences, /welcomeModeOptions\.map/);
  assert.match(preferences, /stays in this browser/);
  assert.match(page, /<WelcomePreferencesDialog/);
  assert.match(page, /formatWelcomeGreeting\(greetingIndex, welcomePreferences\.preferredName/);
  assert.match(page, /aria-label="Fresh chat content"/);
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
