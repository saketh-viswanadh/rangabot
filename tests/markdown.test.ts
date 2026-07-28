import assert from "node:assert/strict";
import test from "node:test";
import { codeLanguage, isBlockCode } from "../lib/markdown.ts";

test("detects fenced code languages", () => {
  assert.equal(codeLanguage("hljs language-typescript"), "typescript");
  assert.equal(codeLanguage(undefined), undefined);
});

test("keeps inline code compact and fenced code in a block", () => {
  assert.equal(isBlockCode("const answer = 42\n", "typescript"), true);
  assert.equal(isBlockCode("two\nlines"), true);
  assert.equal(isBlockCode("npm run dev"), false);
});
