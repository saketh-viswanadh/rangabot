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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  ensurePrivateDirectory,
  ensurePrivateFile,
  supportsPosixPermissions,
  writePrivateJsonFileAtomic,
} from "./private-storage.ts";

const runtimeLeaseVersion = 1;
const maximumLeaseBytes = 4_096;
const acquisitionAttempts = 8;

export const defaultRuntimeLeasePath = resolve(process.cwd(), "data", "rangabot.db-runtime.lock");

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

type RuntimeLeaseOptions = {
  path?: string;
  role: RuntimeLeaseRole;
  ownerPid?: number;
  now?: () => Date;
  token?: () => string;
  inspectProcess?: (pid: number) => ProcessState;
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

function readRecord(path: string): RuntimeLeaseRecord {
  let descriptor: number | undefined;
  try {
    const status = lstatSync(path);
    if (status.isSymbolicLink() || !status.isFile() || status.size > maximumLeaseBytes) {
      throw new RuntimeLeaseError("invalid", "The private Rangabot runtime lease is invalid and was left untouched.");
    }
    const noFollow = supportsPosixPermissions() ? constants.O_NOFOLLOW : 0;
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size > maximumLeaseBytes) {
      throw new RuntimeLeaseError("invalid", "The private Rangabot runtime lease is invalid and was left untouched.");
    }
    const parsed = parseRecord(JSON.parse(readFileSync(descriptor, { encoding: "utf8" })));
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

function removeVerifiedStaleRecord(path: string, expected: RuntimeLeaseRecord) {
  const current = readRecord(path);
  if (
    current.token !== expected.token
    || current.ownerPid !== expected.ownerPid
    || current.runtimePid !== expected.runtimePid
  ) return false;
  unlinkSync(path);
  return true;
}

function publishRecord(path: string, record: RuntimeLeaseRecord) {
  ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.${record.token}.tmp`;
  let descriptor: number | undefined;
  try {
    const noFollow = supportsPosixPermissions() ? constants.O_NOFOLLOW : 0;
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(record)}\n`, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    ensurePrivateFile(temporary);
    // A hard link publishes the already-complete record while preserving the
    // O_EXCL property across cooperating processes.
    linkSync(temporary, path);
    ensurePrivateFile(path);
    unlinkSync(temporary);
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* Keep the original failure. */ }
    }
    try { unlinkSync(temporary); } catch { /* The temporary may not exist. */ }
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

  let acquired = false;
  for (let attempt = 0; attempt < acquisitionAttempts; attempt += 1) {
    try {
      publishRecord(path, record);
      acquired = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readRecord(path);
      if (recordIsActive(existing, inspectProcess)) {
        throw new RuntimeLeaseError("active", "Rangabot is already running or private maintenance is active. Stop it before continuing.");
      }
      try {
        if (!removeVerifiedStaleRecord(path, existing)) continue;
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
      writePrivateJsonFileAtomic(path, record);
    },
    release() {
      if (released) return false;
      if (!ownsCurrentRecord()) {
        released = true;
        return false;
      }
      try { unlinkSync(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      released = true;
      return true;
    },
  };
}
