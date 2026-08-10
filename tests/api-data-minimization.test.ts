import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("browser status omits Knowledge Vault filesystem locations", () => {
  const source = readFileSync("lib/knowledge.ts", "utf8");
  const status = source.slice(source.indexOf("export function getKnowledgeStatus"), source.indexOf("export function listInboxFiles"));
  assert.doesNotMatch(status, /root:\s*knowledgeRoot|inbox:\s*knowledgeInbox/);
});

test("dataset responses expose identity metadata without absolute paths", () => {
  const route = readFileSync("app/api/datasets/route.ts", "utf8");
  assert.match(route, /const \{ id, name, format, sizeBytes, addedAt \} = dataset/);
  assert.doesNotMatch(route, /return \{[^}]*path/);
});

test("raw Knowledge Vault passages are not exposed by a browser API", () => {
  assert.equal(existsSync("app/api/knowledge/search/route.ts"), false);
});

test("repository filesystem identity remains server-only", () => {
  const route = readFileSync("app/api/repositories/route.ts", "utf8");
  assert.match(route, /const \{ id, name, path, addedAt \} = repository/);
  assert.doesNotMatch(route, /rootIdentity/);
});
