import { createLocalSessionSecret, issueLocalBootstrapToken } from "../../lib/local-session-token.ts";
import {
  createDesktopReadinessCapability,
  type DesktopReadinessCapability,
} from "../../lib/desktop-startup-security.ts";
import type { DesktopRuntimeBoundary } from "./resource-boundary.ts";
import {
  RANGABOT_VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS_ENV,
  RANGABOT_VERIFICATION_LOCAL_MODEL_POLICY_ENV,
  VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS,
  VERIFICATION_LOCAL_MODEL_POLICY,
} from "../../lib/desktop-external-filesystem-policy.ts";

const tokenPattern = /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/;

const PASSTHROUGH_ENVIRONMENT = Object.freeze([
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "TZ",
  "KNOWLEDGE_BUDGET_BYTES",
  "KNOWLEDGE_DISABLE_EMBEDDINGS",
  "KNOWLEDGE_DOCTOR_TIMEOUT_MS",
  "OLLAMA_BASE_URL",
  "OLLAMA_EMBED_MODEL",
  "OLLAMA_MODEL",
  "OLLAMA_NUM_CTX",
  "RANGABOT_KNOWLEDGE_BACKUP_RETENTION",
  "RANGABOT_TURN_TIMEOUT_MS",
] as const);

const VERIFICATION_PASSTHROUGH_ENVIRONMENT = Object.freeze([
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
] as const);

export type DesktopVerificationLaunchPolicy = Readonly<{
  externalFilesystemAccess: typeof VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS;
  localModelPolicy: typeof VERIFICATION_LOCAL_MODEL_POLICY;
}>;

export type DesktopLaunch = Readonly<{
  environment: Readonly<Record<string, string>>;
  bootstrapUrl: string;
  readiness: DesktopReadinessCapability;
}>;

export function desktopBootstrapUrl(port: number, bootstrapToken: string) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("A valid OS-assigned loopback port is required.");
  }
  if (!tokenPattern.test(bootstrapToken)) {
    throw new Error("A valid one-launch bootstrap capability is required.");
  }
  const url = new URL("/bootstrap", `http://127.0.0.1:${port}`);
  url.hash = new URLSearchParams({ bootstrap: bootstrapToken }).toString();
  return url.href;
}

export function createDesktopLaunch(input: {
  boundary: DesktopRuntimeBoundary;
  port: number;
  baseEnvironment?: Readonly<Record<string, string | undefined>>;
  verificationPolicy?: DesktopVerificationLaunchPolicy;
}): DesktopLaunch {
  const source = input.baseEnvironment ?? process.env;
  const environment: Record<string, string> = {};
  const passthrough = input.verificationPolicy
    ? VERIFICATION_PASSTHROUGH_ENVIRONMENT
    : PASSTHROUGH_ENVIRONMENT;
  for (const key of passthrough) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) environment[key] = value;
  }
  if (input.verificationPolicy) {
    if (input.verificationPolicy.externalFilesystemAccess !== VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS
      || input.verificationPolicy.localModelPolicy !== VERIFICATION_LOCAL_MODEL_POLICY) {
      throw new Error("The sealed verification launch policy is invalid.");
    }
    environment[RANGABOT_VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS_ENV] = VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS;
    environment[RANGABOT_VERIFICATION_LOCAL_MODEL_POLICY_ENV] = VERIFICATION_LOCAL_MODEL_POLICY;
  }

  const sessionSecret = createLocalSessionSecret();
  const bootstrapToken = issueLocalBootstrapToken(sessionSecret);
  const readiness = createDesktopReadinessCapability();
  environment.HOSTNAME = "127.0.0.1";
  environment.PORT = String(input.port);
  environment.NODE_ENV = "production";
  environment.NEXT_TELEMETRY_DISABLED = "1";
  environment.RANGABOT_DESKTOP = "1";
  environment.RANGABOT_DESKTOP_ARTIFACT_ROOT = input.boundary.artifactRoot;
  environment.RANGABOT_RESOURCE_ROOT = input.boundary.resourceRoot;
  environment.RANGABOT_DATA_ROOT = input.boundary.dataRoot;
  environment.TMPDIR = input.boundary.tempRoot;
  environment.RANGABOT_DESKTOP_MANIFEST_PATH = input.boundary.desktopManifestPath;
  environment.RANGABOT_SESSION_SECRET = sessionSecret;
  environment.RANGABOT_BOOTSTRAP_TOKEN = bootstrapToken;
  environment.RANGABOT_DESKTOP_READINESS_CHALLENGE = readiness.challenge;
  environment.RANGABOT_DESKTOP_READINESS_SECRET = readiness.secret;

  return Object.freeze({
    environment: Object.freeze(environment),
    bootstrapUrl: desktopBootstrapUrl(input.port, bootstrapToken),
    readiness,
  });
}
