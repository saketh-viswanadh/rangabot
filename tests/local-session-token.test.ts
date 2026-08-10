import assert from "node:assert/strict";
import test from "node:test";
import {
  createLocalSessionSecret,
  issueLocalBootstrapToken,
  issueLocalSessionToken,
  verifyExpectedLocalBootstrapToken,
  verifyLocalSessionToken,
} from "../lib/local-session-token.ts";

test("issues unforgeable per-launch local session capabilities", () => {
  const secret = createLocalSessionSecret();
  const token = issueLocalSessionToken(secret);
  assert.equal(verifyLocalSessionToken(token, secret), true);
  assert.equal(verifyLocalSessionToken(token, createLocalSessionSecret()), false);
  const replacement = token.endsWith("x") ? "y" : "x";
  assert.equal(verifyLocalSessionToken(`${token.slice(0, -1)}${replacement}`, secret), false);
  assert.equal(verifyLocalSessionToken(undefined, secret), false);
});

test("rejects malformed capability tokens", () => {
  const secret = createLocalSessionSecret();
  for (const candidate of ["", "short", `${"a".repeat(43)}.${"b".repeat(42)}`, `${"a".repeat(43)}.${"!".repeat(43)}`, `${"a".repeat(43)}.${"b".repeat(43)}.extra`]) {
    assert.equal(verifyLocalSessionToken(candidate, secret), false);
  }
});

test("separates startup capabilities from browser session capabilities", () => {
  const secret = createLocalSessionSecret();
  const bootstrap = issueLocalBootstrapToken(secret);
  const session = issueLocalSessionToken(secret);

  assert.equal(verifyExpectedLocalBootstrapToken(bootstrap, secret, bootstrap), true);
  assert.equal(verifyExpectedLocalBootstrapToken(session, secret, bootstrap), false);
  assert.equal(verifyLocalSessionToken(bootstrap, secret), false);
  assert.equal(verifyExpectedLocalBootstrapToken(bootstrap, secret, undefined), false);
  assert.equal(verifyExpectedLocalBootstrapToken(bootstrap, secret, issueLocalBootstrapToken(secret)), false);
});
