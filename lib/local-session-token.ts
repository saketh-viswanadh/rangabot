import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const tokenPartPattern = /^[A-Za-z0-9_-]{43}$/;
const sessionPurpose = "rangabot-local-session-v1";
const bootstrapPurpose = "rangabot-local-bootstrap-v1";

export function createLocalSessionSecret() {
  return randomBytes(32).toString("base64url");
}

function issuePurposeBoundToken(secret: string, purpose: string, nonce = randomBytes(32).toString("base64url")) {
  if (!tokenPartPattern.test(nonce)) throw new Error("A 256-bit local session nonce is required.");
  const signature = createHmac("sha256", secret).update(`${purpose}\0${nonce}`).digest("base64url");
  return `${nonce}.${signature}`;
}

function verifyPurposeBoundToken(token: string | undefined, secret: string, purpose: string) {
  if (typeof token !== "string") return false;
  const [nonce, signature, extra] = token.split(".");
  if (extra !== undefined || !tokenPartPattern.test(nonce ?? "") || !tokenPartPattern.test(signature ?? "")) return false;
  const expected = createHmac("sha256", secret).update(`${purpose}\0${nonce}`).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(signature, "base64url"); }
  catch { return false; }
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function tokensEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function issueLocalSessionToken(secret: string, nonce?: string) {
  return issuePurposeBoundToken(secret, sessionPurpose, nonce);
}

export function verifyLocalSessionToken(token: string | undefined, secret: string) {
  return verifyPurposeBoundToken(token, secret, sessionPurpose);
}

export function issueLocalBootstrapToken(secret: string, nonce?: string) {
  return issuePurposeBoundToken(secret, bootstrapPurpose, nonce);
}

export function verifyExpectedLocalBootstrapToken(
  token: string | undefined,
  secret: string,
  expectedToken: string | undefined,
) {
  return typeof token === "string"
    && typeof expectedToken === "string"
    && verifyPurposeBoundToken(token, secret, bootstrapPurpose)
    && tokensEqual(token, expectedToken);
}

export function createExpectedLocalBootstrapTokenVerifier(input: {
  secret: string;
  expectedToken: string | undefined;
  consumeOnce: boolean;
}) {
  let consumed = false;
  const matches = (token: string | undefined) => !consumed && verifyExpectedLocalBootstrapToken(
    token,
    input.secret,
    input.expectedToken,
  );
  const consume = (token: string | undefined) => {
    if (!matches(token)) return false;
    if (input.consumeOnce) consumed = true;
    return true;
  };
  return Object.freeze({ matches, consume });
}
