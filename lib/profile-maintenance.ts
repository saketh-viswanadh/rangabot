import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { LocalProfileSessionBinding } from "./local-session-token.ts";
import { getProfileContext, type ProfileContext } from "./profile-context.ts";
import { ensurePrivateDirectory, supportsPosixPermissions } from "./private-storage.ts";
import { PROFILE_REGISTRY_DIRECTORY_NAME } from "./profile-registry.ts";
import { requireNoProfileRecovery } from "./profile-recovery.ts";
import { acquireRuntimeLease, inspectLocalProcess, type ProcessState } from "./runtime-lease.ts";
import { resolveRuntimePathWithinRoot, runtimePaths } from "./runtime-paths.ts";

const delegationEnvironmentKey = "RANGABOT_PROFILE_MAINTENANCE_DELEGATION";
const maximumLeaseBytes = 4_096;
const verifiedMaintenanceBindings = new WeakSet<object>();

type MaintenanceContext = Readonly<{
  binding: LocalProfileSessionBinding;
  profileRoot: string;
}>;

type MaintenanceDelegation = Readonly<{
  schemaVersion: 1;
  ownerPid: number;
  token: string;
  profileId: string;
  generation: number;
  profileRoot: string;
}>;

type MaintenanceEnvironment = Record<string, string | undefined>;

export type ProfileMaintenanceBinding = Readonly<{
  binding: LocalProfileSessionBinding;
  profileRoot: string;
  delegated: boolean;
  assertCurrent(): void;
  assertDataPath(path: string): string;
  dataPath(...components: string[]): string;
  childEnvironment(): Readonly<Record<typeof delegationEnvironmentKey, string>>;
  release(): boolean;
}>;

export type ProfileMaintenanceOptions = Readonly<{
  label: string;
  leasePath?: string;
  trustedRoot?: string;
  environment?: MaintenanceEnvironment;
  ownerPid?: number;
  inspectProcess?: (pid: number) => ProcessState;
  readContext?: () => ProfileContext;
}>;

export function assertVerifiedProfileMaintenanceBinding(
  binding: Pick<ProfileMaintenanceBinding, "assertCurrent">,
) {
  if (!verifiedMaintenanceBindings.has(binding)) {
    throw new Error("A verified private maintenance binding is required.");
  }
  binding.assertCurrent();
}

function contextSnapshot(context: ProfileContext): MaintenanceContext {
  return Object.freeze({
    binding: context.binding,
    profileRoot: resolve(context.setupRequired ? context.legacyRoot : context.profileRoot),
  });
}

function pathIsWithin(root: string, path: string) {
  const child = relative(root, path);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function parseDelegation(encoded: string | undefined): MaintenanceDelegation | null {
  if (!encoded || !/^[A-Za-z0-9_-]{32,2048}$/.test(encoded)) return null;
  try {
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.toString("base64url") !== encoded || decoded.byteLength > 1_536) return null;
    const value = JSON.parse(decoded.toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (!exactKeys(record, ["generation", "ownerPid", "profileId", "profileRoot", "schemaVersion", "token"])
      || record.schemaVersion !== 1
      || !Number.isSafeInteger(record.ownerPid) || Number(record.ownerPid) <= 0
      || typeof record.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(record.token)
      || typeof record.profileId !== "string"
      || !/^(?:legacy|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.test(record.profileId)
      || !Number.isSafeInteger(record.generation) || Number(record.generation) < 0
      || typeof record.profileRoot !== "string" || !isAbsolute(record.profileRoot)
      || resolve(record.profileRoot) !== record.profileRoot) return null;
    return Object.freeze(record as MaintenanceDelegation);
  } catch {
    return null;
  }
}

function encodeDelegation(delegation: MaintenanceDelegation) {
  return Buffer.from(JSON.stringify(delegation), "utf8").toString("base64url");
}

function assertDelegatedLease(path: string, delegation: MaintenanceDelegation, inspectProcess: (pid: number) => ProcessState) {
  let descriptor: number | undefined;
  try {
    const status = lstatSync(path);
    if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1 || status.size > maximumLeaseBytes
      || (process.platform !== "win32" && ((status.mode & 0o077) !== 0
        || (process.getuid && status.uid !== process.getuid())))) {
      throw new Error("The delegated private maintenance lease is unsafe.");
    }
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > maximumLeaseBytes
      || opened.dev !== status.dev || opened.ino !== status.ino) {
      throw new Error("The delegated private maintenance lease is invalid.");
    }
    const record = JSON.parse(readFileSync(descriptor, "utf8")) as Record<string, unknown>;
    const expectedKeys = record.runtimePid === undefined
      ? ["createdAt", "ownerPid", "role", "token", "version"]
      : ["createdAt", "ownerPid", "role", "runtimePid", "token", "version"];
    if (!exactKeys(record, expectedKeys)
      || record.version !== 1
      || record.role !== "maintenance"
      || record.ownerPid !== delegation.ownerPid
      || record.token !== delegation.token
      || inspectProcess(delegation.ownerPid) === "dead") {
      throw new Error("The delegated private maintenance lease is not active.");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("The delegated")) throw error;
    throw new Error("The delegated private maintenance lease could not be verified.");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function canonicalLabel(value: string) {
  const label = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!label || Array.from(label).length > 120 || /[\u0000-\u001f\u007f]/u.test(label)) {
    throw new Error("A bounded private maintenance label is required.");
  }
  return label;
}

function hardenFreshManagedRootBeforeRecovery(trustedRoot: string) {
  const registryRoot = resolveRuntimePathWithinRoot(trustedRoot, PROFILE_REGISTRY_DIRECTORY_NAME);
  try {
    lstatSync(registryRoot);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const status = lstatSync(trustedRoot);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error("The private maintenance root must be a real local directory.");
  }
  if (supportsPosixPermissions() && process.getuid && status.uid !== process.getuid()) {
    throw new Error("The private maintenance root must be owned by the current local user.");
  }
  // Git does not preserve directory privacy bits. A fresh source checkout has
  // no profile registry yet, so harden its owner-controlled data root before
  // the first recovery read. Existing profile state never takes this repair
  // path and remains subject to the strict Recovery privacy checks.
  ensurePrivateDirectory(trustedRoot, { trustedRoot });
}

/**
 * Bind one offline maintenance process to the exact active profile. The app
 * and all cooperating maintenance tools share one managed-root runtime lease,
 * so profile switching cannot race a background write. A child evaluator may
 * adopt only a live, exact parent lease delegation; arbitrary environment
 * assertions never bypass the on-disk lease check.
 */
export function acquireProfileMaintenanceBinding(options: ProfileMaintenanceOptions): ProfileMaintenanceBinding {
  canonicalLabel(options.label);
  const leasePath = resolve(options.leasePath ?? runtimePaths.runtimeLease);
  const trustedRoot = resolve(options.trustedRoot ?? runtimePaths.managedDataRoot);
  const environment = options.environment ?? process.env;
  const readContext = options.readContext ?? getProfileContext;
  const inspectProcess = options.inspectProcess ?? inspectLocalProcess;
  hardenFreshManagedRootBeforeRecovery(trustedRoot);
  requireNoProfileRecovery(trustedRoot);
  const suppliedDelegation = environment[delegationEnvironmentKey];
  const parsedDelegation = parseDelegation(suppliedDelegation);
  if (suppliedDelegation !== undefined && !parsedDelegation) {
    throw new Error("The delegated private maintenance binding is invalid.");
  }

  let lease: ReturnType<typeof acquireRuntimeLease> | undefined;
  let delegation: MaintenanceDelegation;
  let delegated = false;
  if (parsedDelegation) {
    if (leasePath !== resolve(runtimePaths.runtimeLease)) {
      throw new Error("A delegated private maintenance binding cannot select another lease path.");
    }
    assertDelegatedLease(leasePath, parsedDelegation, inspectProcess);
    delegation = parsedDelegation;
    delegated = true;
  } else {
    const token = randomBytes(32).toString("base64url");
    const ownerPid = options.ownerPid ?? process.pid;
    lease = acquireRuntimeLease({
      path: leasePath,
      trustedRoot,
      role: "maintenance",
      ownerPid,
      inspectProcess,
      token: () => token,
    });
    let captured: MaintenanceContext;
    try {
      requireNoProfileRecovery(trustedRoot);
      captured = contextSnapshot(readContext());
    } catch (error) {
      lease.release();
      throw error;
    }
    delegation = Object.freeze({
      schemaVersion: 1,
      ownerPid,
      token,
      profileId: captured.binding.profileId,
      generation: captured.binding.generation,
      profileRoot: captured.profileRoot,
    });
  }

  requireNoProfileRecovery(trustedRoot);
  const captured = contextSnapshot(readContext());
  if (captured.binding.profileId !== delegation.profileId
    || captured.binding.generation !== delegation.generation
    || captured.profileRoot !== delegation.profileRoot) {
    lease?.release();
    throw new Error("The active profile changed while private maintenance was starting.");
  }

  let released = false;
  const assertCurrent = () => {
    if (released) throw new Error("The private maintenance binding has already been released.");
    requireNoProfileRecovery(trustedRoot);
    if (delegated) assertDelegatedLease(leasePath, delegation, inspectProcess);
    const current = contextSnapshot(readContext());
    if (current.binding.profileId !== delegation.profileId
      || current.binding.generation !== delegation.generation
      || current.profileRoot !== delegation.profileRoot) {
      throw new Error("The active profile changed before private maintenance could write.");
    }
  };
  const release = () => {
    if (released) return false;
    released = true;
    if (!delegated) process.off("exit", releaseOnExit);
    return lease?.release() ?? false;
  };
  const releaseOnExit = () => { release(); };
  if (!delegated) process.once("exit", releaseOnExit);

  const result: ProfileMaintenanceBinding = Object.freeze({
    binding: Object.freeze({ profileId: delegation.profileId, generation: delegation.generation }),
    profileRoot: delegation.profileRoot,
    delegated,
    assertCurrent,
    assertDataPath(path: string) {
      assertCurrent();
      const absolute = resolve(path);
      if (!pathIsWithin(delegation.profileRoot, absolute)) {
        throw new Error("A private maintenance path does not belong to the captured profile.");
      }
      return absolute;
    },
    dataPath(...components: string[]) {
      assertCurrent();
      return resolveRuntimePathWithinRoot(delegation.profileRoot, ...components);
    },
    childEnvironment() {
      assertCurrent();
      return Object.freeze({ [delegationEnvironmentKey]: encodeDelegation(delegation) });
    },
    release,
  });
  verifiedMaintenanceBindings.add(result);
  return result;
}
