import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  ensurePrivateDirectory,
  ensurePrivateFile,
  supportsPosixPermissions,
  writePrivateJsonFileAtomic,
} from "./private-storage.ts";
import { runtimePaths } from "./runtime-paths.ts";

const runtimeLeaseVersion = 1;
const maximumLeaseBytes = 4_096;
const acquisitionAttempts = 8;
const claimTokenPattern = /^[0-9a-f]{48}$/;

export const defaultRuntimeLeasePath = runtimePaths.runtimeLease;

export type RuntimeLeaseRole = "app" | "maintenance";
export type ProcessState = "alive" | "dead" | "unknown";

type RuntimeLeaseRecord = {
  version: typeof runtimeLeaseVersion;
  role: RuntimeLeaseRole;
  ownerPid: number;
  runtimePid?: number;
  token: string;
  createdAt: string;
};

export type RuntimeLeaseOptions = {
  path?: string;
  trustedRoot?: string;
  role: RuntimeLeaseRole;
  ownerPid?: number;
  now?: () => Date;
  token?: () => string;
  inspectProcess?: (pid: number) => ProcessState;
  /** @internal Deterministic race injection for runtime lease protocol tests. */
  onLeaseClaimForTests?: (claim: Readonly<{
    path: string;
    claimPath: string;
    expectedToken: string;
  }>) => void;
};

export class RuntimeLeaseError extends Error {
  readonly code: "active" | "invalid";

  constructor(code: "active" | "invalid", message: string) {
    super(message);
    this.name = "RuntimeLeaseError";
    this.code = code;
  }
}

function validPid(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function parseRecord(value: unknown): RuntimeLeaseRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<RuntimeLeaseRecord>;
  if (
    record.version !== runtimeLeaseVersion
    || (record.role !== "app" && record.role !== "maintenance")
    || !validPid(record.ownerPid)
    || (record.runtimePid !== undefined && !validPid(record.runtimePid))
    || typeof record.token !== "string"
    || !/^[A-Za-z0-9_-]{32,128}$/.test(record.token)
    || typeof record.createdAt !== "string"
    || !Number.isFinite(Date.parse(record.createdAt))
  ) return undefined;
  return record as RuntimeLeaseRecord;
}

function sameEntry(
  left: Readonly<{ dev: number; ino: number }>,
  right: Readonly<{ dev: number; ino: number }>,
) {
  return left.dev === right.dev && left.ino === right.ino;
}

function readRecord(path: string, allowLeaseClaims = false): RuntimeLeaseRecord {
  let descriptor: number | undefined;
  try {
    const status = lstatSync(path);
    if (
      status.isSymbolicLink()
      || !status.isFile()
      || (allowLeaseClaims ? status.nlink < 1 : status.nlink !== 1)
      || status.size > maximumLeaseBytes
    ) {
      throw new RuntimeLeaseError("invalid", "The private Rangabot runtime lease is invalid and was left untouched.");
    }
    const noFollow = supportsPosixPermissions() ? constants.O_NOFOLLOW : 0;
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile()
      || (allowLeaseClaims ? opened.nlink < 1 : opened.nlink !== 1)
      || opened.size > maximumLeaseBytes
      || !sameEntry(status, opened)
    ) {
      throw new RuntimeLeaseError("invalid", "The private Rangabot runtime lease is invalid and was left untouched.");
    }
    const content = readFileSync(descriptor, { encoding: "utf8" });
    const after = fstatSync(descriptor);
    if (
      !sameEntry(opened, after)
      || after.size !== opened.size
      || Buffer.byteLength(content, "utf8") !== opened.size
    ) {
      throw new RuntimeLeaseError("invalid", "The private Rangabot runtime lease changed while it was being read.");
    }
    const parsed = parseRecord(JSON.parse(content));
    if (!parsed) throw new RuntimeLeaseError("invalid", "The private Rangabot runtime lease is invalid and was left untouched.");
    return parsed;
  } catch (error) {
    if (error instanceof RuntimeLeaseError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new RuntimeLeaseError("invalid", "The private Rangabot runtime lease is invalid and was left untouched.");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function inspectLocalProcess(pid: number): ProcessState {
  if (!validPid(pid)) return "unknown";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    // EPERM means that a process exists but cannot be signalled. Unknown
    // failures are also treated conservatively so a lease is never stolen.
    return "unknown";
  }
}

function recordIsActive(record: RuntimeLeaseRecord, inspectProcess: (pid: number) => ProcessState) {
  return [record.ownerPid, record.runtimePid]
    .filter((pid): pid is number => pid !== undefined)
    .some((pid) => inspectProcess(pid) !== "dead");
}

function claimPrefix(path: string) {
  return `.${basename(path)}.claim-`;
}

function claimNames(path: string) {
  const prefix = claimPrefix(path);
  return readdirSync(dirname(path))
    .filter((name) => name.startsWith(prefix) && name.endsWith(".tmp"))
    .filter((name) => claimTokenPattern.test(name.slice(prefix.length, -4)))
    .sort();
}

function verifyClaimFile(path: string) {
  const status = lstatSync(path);
  if (
    status.isSymbolicLink()
    || !status.isFile()
    || status.size > maximumLeaseBytes
    || (supportsPosixPermissions() && (status.mode & 0o077) !== 0)
  ) {
    throw new RuntimeLeaseError("invalid", "A Rangabot runtime lease claim is unsafe and was left untouched.");
  }
  return status;
}

function cleanupDetachedClaims(path: string) {
  let canonical: Stats | undefined;
  try { canonical = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const name of claimNames(path)) {
    const claimPath = join(dirname(path), name);
    let claim: Stats;
    try { claim = verifyClaimFile(claimPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (canonical && sameEntry(canonical, claim)) continue;
    try { unlinkSync(claimPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function normalizeStaleClaims(path: string, expected: RuntimeLeaseRecord) {
  for (let attempt = 0; attempt < acquisitionAttempts; attempt += 1) {
    const before = lstatSync(path);
    const current = readRecord(path, true);
    const afterRead = lstatSync(path);
    if (
      !sameEntry(before, afterRead)
      || current.token !== expected.token
      || current.ownerPid !== expected.ownerPid
      || current.runtimePid !== expected.runtimePid
    ) return false;
    if (afterRead.nlink === 1) return true;

    let removedClaim = false;
    for (const name of claimNames(path)) {
      const claimPath = join(dirname(path), name);
      let claim: Stats;
      try { claim = verifyClaimFile(claimPath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!sameEntry(before, claim)) continue;
      try { unlinkSync(claimPath); removedClaim = true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (!removedClaim) {
      throw new RuntimeLeaseError("invalid", "The Rangabot runtime lease has an unrecognized hard link and was left untouched.");
    }
    let finalLease: Stats;
    try { finalLease = lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (!sameEntry(before, finalLease)) return false;
    if (finalLease.nlink === 1) return true;
  }
  return false;
}

function removeVerifiedRecord(
  path: string,
  expected: RuntimeLeaseRecord,
  onLeaseClaimForTests?: RuntimeLeaseOptions["onLeaseClaimForTests"],
) {
  const before = lstatSync(path);
  const current = readRecord(path);
  const after = lstatSync(path);
  if (
    !sameEntry(before, after)
    || current.token !== expected.token
    || current.ownerPid !== expected.ownerPid
    || current.runtimePid !== expected.runtimePid
  ) return false;

  // Claim the exact inspected inode through a private hard link. The public
  // lease pathname cannot be replaced while it exists. If another reclaimer
  // also claims the inode, the link count is no longer exactly two and this
  // attempt backs off without unlinking any pathname it did not inspect.
  let claimPath: string | undefined;
  for (let attempt = 0; attempt < acquisitionAttempts; attempt += 1) {
    const candidate = join(
      dirname(path),
      `${claimPrefix(path)}${randomBytes(24).toString("hex")}.tmp`,
    );
    try {
      linkSync(path, candidate);
      claimPath = candidate;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  if (claimPath === undefined) {
    throw new RuntimeLeaseError("active", "A unique Rangabot runtime lease claim could not be created.");
  }

  let removed = false;
  try {
    const claimed = lstatSync(claimPath);
    if (!sameEntry(before, claimed)) return false;

    onLeaseClaimForTests?.({ path, claimPath, expectedToken: expected.token });

    const finalLease = lstatSync(path);
    const finalClaim = lstatSync(claimPath);
    if (
      !sameEntry(before, finalLease)
      || !sameEntry(before, finalClaim)
      || finalLease.nlink !== 2
      || finalClaim.nlink !== 2
    ) return false;
    unlinkSync(path);
    removed = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally {
    try { unlinkSync(claimPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return removed;
}

function publishRecord(path: string, record: RuntimeLeaseRecord, trustedRoot?: string) {
  ensurePrivateDirectory(dirname(path), { trustedRoot });
  const temporary = `${path}.${record.token}.tmp`;
  let descriptor: number | undefined;
  let publishedIdentity: Readonly<{ dev: number; ino: number }> | undefined;
  try {
    const noFollow = supportsPosixPermissions() ? constants.O_NOFOLLOW : 0;
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(record)}\n`, { encoding: "utf8" });
    fsyncSync(descriptor);
    const written = fstatSync(descriptor);
    publishedIdentity = Object.freeze({ dev: written.dev, ino: written.ino });
    closeSync(descriptor);
    descriptor = undefined;
    ensurePrivateFile(temporary, { trustedRoot });
    // A hard link publishes the already-complete record while preserving the
    // O_EXCL property across cooperating processes.
    linkSync(temporary, path);
    unlinkSync(temporary);
    // Remove the temporary link before enforcing the single-link private-file
    // invariant. The published pathname remains the same verified inode.
    ensurePrivateFile(path, { trustedRoot });
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* Keep the original failure. */ }
    }
    try { unlinkSync(temporary); } catch { /* The temporary may not exist. */ }
    if (publishedIdentity) {
      try {
        const published = lstatSync(path);
        if (published.dev === publishedIdentity.dev && published.ino === publishedIdentity.ino) unlinkSync(path);
      } catch { /* Never remove a replacement or mask the original failure. */ }
    }
    throw error;
  }
}

export type RuntimeLease = {
  registerRuntimeProcess: (pid: number) => void;
  release: () => boolean;
};

export function acquireRuntimeLease(options: RuntimeLeaseOptions): RuntimeLease {
  const path = resolve(options.path ?? defaultRuntimeLeasePath);
  const ownerPid = options.ownerPid ?? process.pid;
  if (!validPid(ownerPid)) throw new RuntimeLeaseError("invalid", "The Rangabot runtime process identity is invalid.");
  const inspectProcess = options.inspectProcess ?? inspectLocalProcess;
  const record: RuntimeLeaseRecord = {
    version: runtimeLeaseVersion,
    role: options.role,
    ownerPid,
    token: (options.token ?? (() => randomBytes(32).toString("base64url")))(),
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  if (!parseRecord(record)) throw new RuntimeLeaseError("invalid", "The Rangabot runtime lease could not be created safely.");

  ensurePrivateDirectory(dirname(path), { trustedRoot: options.trustedRoot });
  let acquired = false;
  for (let attempt = 0; attempt < acquisitionAttempts; attempt += 1) {
    cleanupDetachedClaims(path);
    try {
      publishRecord(path, record, options.trustedRoot);
      acquired = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readRecord(path, true);
      if (recordIsActive(existing, inspectProcess)) {
        throw new RuntimeLeaseError("active", "Rangabot is already running or private maintenance is active. Stop it before continuing.");
      }
      try {
        if (!normalizeStaleClaims(path, existing)) continue;
        if (!removeVerifiedRecord(path, existing, options.onLeaseClaimForTests)) continue;
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw cleanupError;
      }
    }
  }
  if (!acquired) throw new RuntimeLeaseError("active", "The Rangabot runtime lease changed during acquisition. Try again after stopping the app.");

  let released = false;
  const ownsCurrentRecord = () => {
    try { return readRecord(path).token === record.token; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      if (error instanceof RuntimeLeaseError) return false;
      throw error;
    }
  };

  return {
    registerRuntimeProcess(pid: number) {
      if (released || !validPid(pid)) throw new RuntimeLeaseError("invalid", "The Rangabot runtime process identity is invalid.");
      if (!ownsCurrentRecord()) throw new RuntimeLeaseError("active", "The Rangabot runtime lease is no longer owned by this process.");
      record.runtimePid = pid;
      writePrivateJsonFileAtomic(path, record, { trustedRoot: options.trustedRoot });
    },
    release() {
      if (released) return false;
      try {
        const removed = removeVerifiedRecord(path, record, options.onLeaseClaimForTests);
        released = true;
        return removed;
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          released = true;
          return false;
        }
        throw error;
      }
    },
  };
}
