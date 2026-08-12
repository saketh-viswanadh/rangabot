import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const DESKTOP_READINESS_PATH = "/api/local-session/desktop-readiness";
export const DESKTOP_READINESS_CHALLENGE_HEADER = "X-Rangabot-Desktop-Readiness-Challenge";
export const DESKTOP_READINESS_PROCESS_HEADER = "X-Rangabot-Desktop-Readiness-Process";
export const DESKTOP_READINESS_PROOF_HEADER = "X-Rangabot-Desktop-Readiness-Proof";

const capabilityPattern = /^[A-Za-z0-9_-]{43}$/;
const processPattern = /^[1-9][0-9]{0,9}$/;
const readinessPurpose = "rangabot-desktop-readiness-v1";

export type DesktopReadinessCapability = Readonly<{
  challenge: string;
  secret: string;
}>;

export function createDesktopReadinessCapability(): DesktopReadinessCapability {
  return Object.freeze({
    challenge: randomBytes(32).toString("base64url"),
    secret: randomBytes(32).toString("base64url"),
  });
}

function validateCapabilityPart(value: string, label: string) {
  if (!capabilityPattern.test(value)) throw new Error(`A valid 256-bit desktop readiness ${label} is required.`);
}

function validateProcessId(processId: number) {
  if (!Number.isSafeInteger(processId) || processId < 1 || processId > 2_147_483_647) {
    throw new Error("A valid supervised desktop server process ID is required.");
  }
}

function readinessPayload(challenge: string, processId: number) {
  return `${readinessPurpose}\0${challenge}\0${processId}`;
}

export function issueDesktopReadinessProof(input: {
  challenge: string;
  secret: string;
  processId: number;
}) {
  validateCapabilityPart(input.challenge, "challenge");
  validateCapabilityPart(input.secret, "secret");
  validateProcessId(input.processId);
  return createHmac("sha256", input.secret)
    .update(readinessPayload(input.challenge, input.processId))
    .digest("base64url");
}

export function verifyDesktopReadinessProof(input: {
  challenge: string;
  secret: string;
  expectedProcessId: number;
  reportedProcessId: string | undefined;
  proof: string | undefined;
}) {
  try {
    validateCapabilityPart(input.challenge, "challenge");
    validateCapabilityPart(input.secret, "secret");
    validateProcessId(input.expectedProcessId);
  } catch {
    return false;
  }
  if (typeof input.reportedProcessId !== "string" || !processPattern.test(input.reportedProcessId)) return false;
  const reportedProcessId = Number(input.reportedProcessId);
  if (reportedProcessId !== input.expectedProcessId || typeof input.proof !== "string" || !capabilityPattern.test(input.proof)) {
    return false;
  }
  const expected = Buffer.from(issueDesktopReadinessProof({
    challenge: input.challenge,
    secret: input.secret,
    processId: reportedProcessId,
  }));
  const supplied = Buffer.from(input.proof);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export type DesktopReadinessRequestInput = Readonly<{
  desktopMode: boolean;
  expectedChallenge: string | undefined;
  port: string | undefined;
  url: string;
  method: string;
  headers: Headers;
}>;

export function evaluateDesktopReadinessRequest(input: DesktopReadinessRequestInput) {
  if (!input.desktopMode
    || typeof input.expectedChallenge !== "string"
    || !capabilityPattern.test(input.expectedChallenge)
    || typeof input.port !== "string"
    || !/^[1-9][0-9]{0,4}$/.test(input.port)) return false;
  const port = Number(input.port);
  if (port > 65_535) return false;
  const exactOrigin = `http://127.0.0.1:${port}`;
  let requestUrl: URL;
  try { requestUrl = new URL(input.url); }
  catch { return false; }
  return input.method.toUpperCase() === "POST"
    && requestUrl.origin === exactOrigin
    && requestUrl.pathname === DESKTOP_READINESS_PATH
    && requestUrl.search === ""
    && input.headers.get("host") === `127.0.0.1:${port}`
    && input.headers.get(DESKTOP_READINESS_CHALLENGE_HEADER) === input.expectedChallenge
    && input.headers.get("content-length") === "0"
    && !input.headers.has("transfer-encoding")
    && !input.headers.has("content-encoding")
    && !input.headers.has("origin")
    && !input.headers.has("sec-fetch-site");
}
