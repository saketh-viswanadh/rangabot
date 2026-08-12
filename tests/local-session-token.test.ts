import assert from "node:assert/strict";
import test from "node:test";
import {
  createExpectedLocalBootstrapTokenVerifier,
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
  const [nonce, signature] = token.split(".");
  const replacement = signature.startsWith("x") ? "y" : "x";
  assert.equal(verifyLocalSessionToken(`${nonce}.${replacement}${signature.slice(1)}`, secret), false);
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

test("desktop bootstrap capability is synchronously consumed exactly once", () => {
  const secret = createLocalSessionSecret();
  const bootstrap = issueLocalBootstrapToken(secret);
  const verifier = createExpectedLocalBootstrapTokenVerifier({
    secret,
    expectedToken: bootstrap,
    consumeOnce: true,
  });

  assert.equal(verifier.matches(bootstrap), true);
  assert.equal(verifier.consume(issueLocalBootstrapToken(secret)), false, "a different valid capability cannot consume this launch");
  assert.equal(verifier.consume(bootstrap), true);
  assert.equal(verifier.matches(bootstrap), false);
  assert.equal(verifier.consume(bootstrap), false, "replay must fail after the first successful consumption");
});

test("CLI bootstrap capability preserves launch-bound reusable semantics", () => {
  const secret = createLocalSessionSecret();
  const bootstrap = issueLocalBootstrapToken(secret);
  const verifier = createExpectedLocalBootstrapTokenVerifier({
    secret,
    expectedToken: bootstrap,
    consumeOnce: false,
  });

  assert.equal(verifier.consume(bootstrap), true);
  assert.equal(verifier.consume(bootstrap), true);
  assert.equal(verifier.matches(bootstrap), true);
});
