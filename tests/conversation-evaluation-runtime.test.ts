import assert from "node:assert/strict";
import test from "node:test";
import { readConversationEvaluationGitCandidate } from "../lib/conversation-evaluation-runtime.ts";

test("records clean SHA-1 and SHA-256 candidates without weakening dirty detection", () => {
  for (const commit of ["a".repeat(40), "b".repeat(64)]) {
    const clean = readConversationEvaluationGitCandidate((_command, args) => args.includes("rev-parse") ? `${commit}\n` : "");
    assert.deepEqual(clean, { commit, dirty: false });
    const dirty = readConversationEvaluationGitCandidate((_command, args) => args.includes("rev-parse") ? `${commit}\n` : " M lib/file.ts\n");
    assert.deepEqual(dirty, { commit, dirty: true });
  }
});

test("fails closed when either Git metadata command fails", () => {
  assert.throws(
    () => readConversationEvaluationGitCandidate(() => { throw new Error("git unavailable"); }),
    /git unavailable/,
  );
  assert.throws(
    () => readConversationEvaluationGitCandidate((_command, args) => {
      if (args.includes("rev-parse")) return `${"a".repeat(40)}\n`;
      throw new Error("status unavailable");
    }),
    /status unavailable/,
  );
  assert.throws(
    () => readConversationEvaluationGitCandidate((_command, args) => args.includes("rev-parse") ? "not-a-commit" : ""),
    /valid SHA-1 or SHA-256 Git HEAD/,
  );
});
