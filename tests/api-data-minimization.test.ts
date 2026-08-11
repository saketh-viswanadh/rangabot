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

test("response feedback APIs expose state only and never conversation content", () => {
  const collection = readFileSync("app/api/conversations/[id]/feedback/route.ts", "utf8");
  const mutation = readFileSync("app/api/conversations/[id]/feedback/[turnId]/route.ts", "utf8");
  const storage = readFileSync("lib/response-feedback.ts", "utf8");
  assert.doesNotMatch(`${collection}\n${mutation}`, /assistantMessage|userMessage|messages\s*:/);
  assert.match(mutation, /Object\.keys\(record\)\.length !== 1/);
  assert.match(storage, /turn_id, rating, candidate_build_id, response_day_utc, created_at, updated_at/);
  assert.doesNotMatch(storage, /response_text|prompt|reason|memory|attachment|device|model_output/i);
});
