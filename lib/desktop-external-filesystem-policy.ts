import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * This environment key is written only by the sealed verification desktop
 * launcher. It is intentionally not a general-purpose path or profile
 * selector. Supplying it to CLI mode can only remove product capability.
 */
export const RANGABOT_VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS_ENV =
  "RANGABOT_VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS" as const;
export const RANGABOT_VERIFICATION_LOCAL_MODEL_POLICY_ENV =
  "RANGABOT_VERIFICATION_LOCAL_MODEL_POLICY" as const;

export const VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS = "deny" as const;
export const VERIFICATION_LOCAL_MODEL_POLICY = "disabled" as const;
export type VerificationExternalFilesystemAccess = typeof VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS;

export const VERIFICATION_EXTERNAL_PATH_ENTRY_POINTS = Object.freeze([
  "repository-approval",
  "repository-registry-validation",
  "repository-search",
  "repository-preview",
  "dataset-approval",
  "dataset-registry-validation",
  "dataset-identity-validation",
  "dataset-snapshot",
  "dataset-schema",
  "dataset-sql-execution",
  "conversation-import",
  "memory-import",
] as const);

type PolicyEnvironment = Readonly<Record<string, string | undefined>>;

export class VerificationExternalFilesystemAccessError extends Error {
  constructor() {
    super("External filesystem access is disabled in this sealed verification build.");
    this.name = "VerificationExternalFilesystemAccessError";
  }
}

export function verificationExternalFilesystemAccess(
  environment: PolicyEnvironment = process.env,
): VerificationExternalFilesystemAccess | null {
  const value = environment[RANGABOT_VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS_ENV];
  if (value === undefined) return null;
  if (value !== VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS) {
    throw new Error("The verification external-filesystem policy is invalid.");
  }
  return value;
}

export function verificationLocalModelDisabled(environment: PolicyEnvironment = process.env) {
  const value = environment[RANGABOT_VERIFICATION_LOCAL_MODEL_POLICY_ENV];
  if (value === undefined) return false;
  if (value !== VERIFICATION_LOCAL_MODEL_POLICY) {
    throw new Error("The verification local-model policy is invalid.");
  }
  return true;
}

/**
 * Verification builds deny before examining, canonicalizing, statting or
 * opening the supplied target. This deliberately provides no existence oracle
 * for a real-home, temporary, URI, relative, traversal or symlinked path.
 */
export function assertExternalFilesystemPathAccess(
  _path: string,
  _entryPoint: typeof VERIFICATION_EXTERNAL_PATH_ENTRY_POINTS[number],
  environment: PolicyEnvironment = process.env,
) {
  if (verificationExternalFilesystemAccess(environment) !== null) {
    throw new VerificationExternalFilesystemAccessError();
  }
}

export function assertExternalImportAccess(
  entryPoint: "conversation-import" | "memory-import",
  environment: PolicyEnvironment = process.env,
) {
  assertExternalFilesystemPathAccess("external-import", entryPoint, environment);
}

export function assertExternalRegistryEntriesAllowed(
  entries: readonly unknown[],
  environment: PolicyEnvironment = process.env,
) {
  if (verificationExternalFilesystemAccess(environment) !== null && entries.length > 0) {
    throw new VerificationExternalFilesystemAccessError();
  }
}

type RegistryKind = "repositories" | "datasets";

export type VerificationRegistryPreflight = Readonly<{
  kind: RegistryKind;
  path: string;
  status: "missing" | "empty";
}>;

function pathIsWithin(root: string, path: string) {
  const traversal = relative(root, path);
  return traversal === "" || (!isAbsolute(traversal) && traversal !== ".." && !traversal.startsWith(`..${sep}`));
}

function requireExactPrivateDataRoot(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error("The verification DATA_ROOT must be an explicit normalized absolute path.");
  }
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isDirectory() || realpathSync(path) !== path) {
    throw new Error("The verification DATA_ROOT must be a real canonical directory.");
  }
  if (process.platform !== "win32" && (status.mode & 0o077) !== 0) {
    throw new Error("The verification DATA_ROOT must be owner-only.");
  }
  if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
    throw new Error("The verification DATA_ROOT must be owned by the current user.");
  }
  return path;
}

function readRegistryArray(path: string, dataRoot: string): unknown[] | null {
  if (!pathIsWithin(dataRoot, path) || path === dataRoot) {
    throw new Error("A verification registry path escaped DATA_ROOT.");
  }
  if (!existsSync(path)) return null;
  const before = lstatSync(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || before.size > BigInt(1024 * 1024)) {
    throw new Error("A verification external-filesystem registry is unsafe.");
  }
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size || opened.mtimeNs !== before.mtimeNs || opened.ctimeNs !== before.ctimeNs) {
      throw new Error("A verification external-filesystem registry changed during preflight.");
    }
    const parsed: unknown = JSON.parse(readFileSync(descriptor, "utf8"));
    const after = lstatSync(path, { bigint: true });
    if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino
      || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) {
      throw new Error("A verification external-filesystem registry changed during preflight.");
    }
    if (!Array.isArray(parsed)) throw new Error("A verification external-filesystem registry is malformed.");
    return parsed;
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Read-only startup preflight. In the selected deny profile, even a syntactically
 * valid persisted approval is fatal and its target is never inspected. Missing
 * and empty registries are the only accepted states.
 */
export function preflightVerificationExternalFilesystemRegistries(input: {
  dataRoot: string;
  environment?: PolicyEnvironment;
}): VerificationRegistryPreflight[] {
  if (verificationExternalFilesystemAccess(input.environment ?? process.env) === null) return [];
  const dataRoot = requireExactPrivateDataRoot(input.dataRoot);
  return (["repositories", "datasets"] as const).map((kind) => {
    const path = join(dataRoot, `${kind}.json`);
    const entries = readRegistryArray(path, dataRoot);
    if (entries && entries.length > 0) throw new VerificationExternalFilesystemAccessError();
    return Object.freeze({ kind, path, status: entries === null ? "missing" as const : "empty" as const });
  });
}
