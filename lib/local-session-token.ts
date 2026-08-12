import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const tokenPartPattern = /^[A-Za-z0-9_-]{43}$/;
const profileIdPattern = /^(?:legacy|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
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

export type LocalProfileSessionBinding = Readonly<{ profileId: string; generation: number }>;

export const LEGACY_PROFILE_SESSION_BINDING: LocalProfileSessionBinding = Object.freeze({ profileId: "legacy", generation: 0 });

function validProfileSessionBinding(value: unknown): value is LocalProfileSessionBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.profileId === "string" && profileIdPattern.test(record.profileId)
    && Number.isSafeInteger(record.generation) && Number(record.generation) >= 0;
}

export function localProfileSessionContext(binding: LocalProfileSessionBinding) {
  if (!validProfileSessionBinding(binding)) throw new Error("A valid local profile session binding is required.");
  return `${binding.profileId}:${binding.generation}`;
}

export function parseLocalProfileSessionContext(value: string | undefined): LocalProfileSessionBinding | null {
  if (typeof value !== "string") return null;
  const split = value.lastIndexOf(":");
  if (split < 1) return null;
  const profileId = value.slice(0, split);
  const generationText = value.slice(split + 1);
  if (!profileIdPattern.test(profileId) || !/^(?:0|[1-9][0-9]{0,15})$/.test(generationText)) return null;
  const generation = Number(generationText);
  return Number.isSafeInteger(generation) ? Object.freeze({ profileId, generation }) : null;
}

function issueProfileBoundSessionToken(secret: string, binding: LocalProfileSessionBinding, nonce = randomBytes(32).toString("base64url")) {
  if (!tokenPartPattern.test(nonce)) throw new Error("A 256-bit local session nonce is required.");
  const context = localProfileSessionContext(binding);
  const encodedContext = Buffer.from(context, "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(`${sessionPurpose}\0${nonce}\0${context}`).digest("base64url");
  return `${nonce}.${encodedContext}.${signature}`;
}

export function issueLocalSessionToken(
  secret: string,
  bindingOrNonce: LocalProfileSessionBinding | string = LEGACY_PROFILE_SESSION_BINDING,
  nonce?: string,
) {
  return typeof bindingOrNonce === "string"
    ? issueProfileBoundSessionToken(secret, LEGACY_PROFILE_SESSION_BINDING, bindingOrNonce)
    : issueProfileBoundSessionToken(secret, bindingOrNonce, nonce);
}

export function parseLocalSessionTokenBinding(token: string | undefined): LocalProfileSessionBinding | null {
  if (typeof token !== "string") return null;
  const [nonce, encodedContext, signature, extra] = token.split(".");
  if (extra !== undefined || !tokenPartPattern.test(nonce ?? "") || !tokenPartPattern.test(signature ?? "")
    || typeof encodedContext !== "string" || !/^[A-Za-z0-9_-]{3,128}$/.test(encodedContext)) return null;
  try {
    const context = Buffer.from(encodedContext, "base64url").toString("utf8");
    if (Buffer.from(context, "utf8").toString("base64url") !== encodedContext) return null;
    return parseLocalProfileSessionContext(context);
  } catch {
    return null;
  }
}

export function verifyLocalSessionToken(
  token: string | undefined,
  secret: string,
  expectedBinding?: LocalProfileSessionBinding,
) {
  if (typeof token !== "string") return false;
  const [nonce, , signature, extra] = token.split(".");
  if (extra !== undefined || !tokenPartPattern.test(nonce ?? "") || !tokenPartPattern.test(signature ?? "")) return false;
  const binding = parseLocalSessionTokenBinding(token);
  if (!binding) return false;
  const context = localProfileSessionContext(binding);
  if (expectedBinding && context !== localProfileSessionContext(expectedBinding)) return false;
  const expected = createHmac("sha256", secret).update(`${sessionPurpose}\0${nonce}\0${context}`).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(signature, "base64url"); }
  catch { return false; }
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
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
