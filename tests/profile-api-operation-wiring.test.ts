import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string) {
  return readFileSync(path, "utf8");
}

const chat = source("app/api/chat/route.ts");

test("generation claims and streaming settlement stay bound to one profile generation", () => {
  const handler = chat.slice(chat.indexOf("async function handleVersionedChat"), chat.indexOf("export async function POST"));
  assert.ok(handler.indexOf("profileBindingFromRequest(request)") < handler.indexOf("profileOperations.begin"));
  assert.ok(handler.indexOf("profileOperations.begin") < handler.indexOf("claimConversationTurn"));
  assert.match(handler, /kind:\s*"generation"/);
  assert.match(handler, /cancellable:\s*true/);
  assert.match(handler, /profileOperation\.signal/);
  assert.match(handler, /lifecycleCallbacks[\s\S]*profileOperation\.release\(\)/);
  assert.match(handler, /catch \(error\) \{[\s\S]*profileOperation\.release\(\);[\s\S]*turnErrorResponse/);
});

test("long-running local work uses exact operation classes and safe cancellation claims", () => {
  const expected = new Map([
    ["app/api/conversations/import/route.ts", "import"],
    ["app/api/memories/import/route.ts", "import"],
    ["app/api/analysis/sql/preview/route.ts", "dataset-processing"],
    ["app/api/analysis/sql/execute/route.ts", "dataset-processing"],
    ["app/api/repositories/[id]/preview/route.ts", "tool-execution"],
    ["app/api/repositories/[id]/search/route.ts", "tool-execution"],
    ["app/api/status/route.ts", "tool-execution"],
    ["app/api/models/route.ts", "tool-execution"],
    ["app/api/models/install/route.ts", "tool-execution"],
    ["app/api/conversations/[id]/export/route.ts", "export"],
    ["app/api/memories/export/route.ts", "export"],
  ]);
  for (const [path, kind] of expected) {
    const route = source(path);
    assert.match(route, new RegExp(`withProfileRequest\\(request, \\{ kind: "${kind}"`), path);
  }
  const install = source("app/api/models/install/route.ts");
  assert.doesNotMatch(install, /cancellable:\s*true/);
});

test("profile-scoped mutations use operation leases instead of header-only checks", () => {
  const mutationRoutes = [
    "app/api/conversation-turns/route.ts",
    "app/api/conversations/[id]/route.ts",
    "app/api/conversations/[id]/feedback/[turnId]/route.ts",
    "app/api/datasets/route.ts",
    "app/api/datasets/[id]/route.ts",
    "app/api/memories/route.ts",
    "app/api/memories/[id]/route.ts",
    "app/api/models/route.ts",
    "app/api/preferences/route.ts",
    "app/api/projects/route.ts",
    "app/api/projects/[id]/route.ts",
    "app/api/repositories/route.ts",
    "app/api/repositories/[id]/route.ts",
  ];
  for (const path of mutationRoutes) {
    const route = source(path);
    assert.match(route, /withProfileRequest\(request, \{ kind: "(?:database-mutation|import)"/, path);
  }
});

test("profile lifecycle endpoints reject stale sessions without self-deadlocking restore", () => {
  const routes = [
    "app/api/profiles/route.ts",
    "app/api/profiles/setup/route.ts",
    "app/api/profiles/[id]/route.ts",
    "app/api/profiles/[id]/switch/route.ts",
    "app/api/profiles/[id]/reset/route.ts",
    "app/api/profiles/[id]/backup/route.ts",
    "app/api/profiles/restore/route.ts",
  ];
  for (const path of routes) assert.match(source(path), /profileBindingFromRequest\(request\)/, path);
  const restore = source("app/api/profiles/restore/route.ts");
  assert.equal(restore.match(/profileBindingFromRequest\(request\)/g)?.length, 2);
  assert.doesNotMatch(restore, /withProfileRequest/);
});

test("all browser routes that expose profile-private state recheck the profile context", () => {
  const readRoutes = [
    "app/api/conversations/route.ts",
    "app/api/conversations/[id]/route.ts",
    "app/api/conversations/[id]/feedback/route.ts",
    "app/api/datasets/route.ts",
    "app/api/knowledge/status/route.ts",
    "app/api/knowledge/updates/route.ts",
    "app/api/knowledge/welcome/route.ts",
    "app/api/memories/route.ts",
    "app/api/models/route.ts",
    "app/api/preferences/route.ts",
    "app/api/projects/route.ts",
    "app/api/repositories/route.ts",
    "app/api/artifacts/word/[id]/document/route.ts",
    "app/api/artifacts/word/[id]/preview/[page]/route.ts",
  ];
  for (const path of readRoutes) {
    assert.match(source(path), /profileBindingFromRequest\(request\)|withProfileRequest\(request/, path);
  }
  assert.match(source("app/api/runtime/candidate/route.ts"), /profileBindingFromRequest\(request\)/);
});

test("Testing profiles cannot adopt legacy unscoped preferences", () => {
  const preferences = source("app/api/preferences/route.ts");
  const legacyImport = preferences.slice(preferences.indexOf("export async function POST"));
  assert.ok(legacyImport.indexOf("assertProfileAcceptsExternalUserData()") < legacyImport.indexOf("readDesktopPreferencesMutation"));
});

test("the Analytics Expert Pack follows the active profile model selection", () => {
  const analytics = source("lib/analytics-expert-pack.ts");
  assert.match(analytics, /import \{ selectedChatModel \} from "\.\/model-manager\.ts"/);
  assert.match(analytics, /configuredModel: selectedChatModel/);
  assert.doesNotMatch(analytics, /getConfiguredChatModel/);
});
