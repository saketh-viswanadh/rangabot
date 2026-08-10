import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const evaluationScripts = [
  "scripts/analytical-holdout-runner.ts",
  "scripts/evaluate-analytical-holdout.ts",
  "scripts/evaluate-analytical-narration.ts",
  "scripts/evaluate-conversation.ts",
  "scripts/evaluate-conversational-sql.ts",
  "scripts/evaluate-knowledge-answers.ts",
  "scripts/evaluate-knowledge.ts",
  "scripts/evaluate-memory-selection.ts",
  "scripts/evaluate-model-matrix.ts",
  "scripts/qualify-conversation-reviewer.ts",
] as const;

function source(path: string) {
  return readFileSync(resolve(path), "utf8");
}

test("every private evaluator uses the shared owner-only atomic output boundary", () => {
  for (const path of evaluationScripts) {
    const code = source(path);
    assert.match(code, /ensurePrivateDirectory/iu, `${path} must secure its result directory`);
    assert.match(code, /writePrivate(?:Json|Text)FileAtomic/iu, `${path} must use an atomic private writer`);
    assert.doesNotMatch(code, /\bmkdirSync\s*\(|\bwriteFileSync\s*\(|\bawait\s+(?:mkdir|writeFile)\s*\(/u, `${path} bypasses private storage`);
  }
});

test("private evaluation databases stay inside owner-only directories and are hardened after close", () => {
  for (const path of [
    "scripts/analytical-holdout-runner.ts",
    "scripts/evaluate-analytical-holdout.ts",
    "scripts/evaluate-conversational-sql.ts",
  ]) {
    const code = source(path);
    assert.match(code, /ensurePrivateDirectory\((?:outputDirectory|resultsDirectory)\)/u, `${path} must isolate its database directory`);
    assert.match(code, /ensurePrivateFile\(databasePath\)/u, `${path} must harden its closed database file`);
  }
});

test("Knowledge Vault runtime directory creation uses the shared private boundary", () => {
  const code = source("lib/knowledge.ts");
  assert.match(code, /ensurePrivateDirectory\(knowledgeInbox\)/u);
  assert.doesNotMatch(code, /mkdirSync\(knowledgeInbox/u);
});
