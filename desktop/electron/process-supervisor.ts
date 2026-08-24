import { execFile } from "node:child_process";
import { join } from "node:path";
import {
  acquireRuntimeLease,
  inspectLocalProcess,
  type ProcessState,
  type RuntimeLease,
  type RuntimeLeaseOptions,
} from "../../lib/runtime-lease.ts";
import type { DesktopLaunch } from "./launch-environment.ts";
import type { DesktopRuntimeBoundary } from "./resource-boundary.ts";

export type UtilityProcessLike = {
  readonly pid?: number;
  readonly stdout?: NodeJS.ReadableStream | null;
  readonly stderr?: NodeJS.ReadableStream | null;
  kill(): boolean;
  once(event: "spawn", listener: () => void): unknown;
  once(event: "exit", listener: (code: number) => void): unknown;
};

export type UtilityProcessFork = (
  modulePath: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    execArgv: string[];
    stdio: "pipe";
    serviceName: string;
    allowLoadingUnsignedLibraries: false;
    disclaim: false;
  },
) => UtilityProcessLike;

export type ProcessExit = Readonly<{ code: number }>;

export type ProcessTableEntry = Readonly<{ pid: number; parentPid: number }>;

export function parseProcessTable(output: string): ProcessTableEntry[] {
  return output.split("\n").flatMap((line) => {
    const match = /^\s*([1-9][0-9]*)\s+([0-9]+)\s*$/.exec(line);
    if (!match) return [];
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parentPid)) return [];
    return [{ pid, parentPid }];
  });
}

export function descendantProcessIds(rootPid: number, table: readonly ProcessTableEntry[]) {
  const byParent = new Map<number, number[]>();
  for (const entry of table) {
    const children = byParent.get(entry.parentPid) ?? [];
    children.push(entry.pid);
    byParent.set(entry.parentPid, children);
  }
  const descendants: Array<{ pid: number; depth: number }> = [];
  const pending = [{ pid: rootPid, depth: 0 }];
  const seen = new Set([rootPid]);
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current) break;
    for (const child of byParent.get(current.pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      descendants.push({ pid: child, depth: current.depth + 1 });
      pending.push({ pid: child, depth: current.depth + 1 });
    }
  }
  return descendants.sort((left, right) => right.depth - left.depth || right.pid - left.pid).map(({ pid }) => pid);
}

export async function listMacProcessDescendants(rootPid: number) {
  if (process.platform !== "darwin") return [];
  const output = await new Promise<string>((resolve, reject) => {
    execFile("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
  return descendantProcessIds(rootPid, parseProcessTable(output));
}

export async function terminateWindowsProcessTree(rootPid: number, force: boolean) {
  if (process.platform !== "win32") return;
  await new Promise<void>((resolve) => {
    execFile("taskkill.exe", ["/PID", String(rootPid), "/T", ...(force ? ["/F"] : [])], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
    }, () => resolve());
  });
}

function drain(stream: NodeJS.ReadableStream | null | undefined) {
  stream?.on("data", () => undefined);
}

function signalIfAlive(pid: number, signal: NodeJS.Signals, sendSignal: typeof process.kill) {
  try {
    sendSignal(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForExit(exit: Promise<ProcessExit>, timeoutMs: number) {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      exit.then(() => true),
      new Promise<false>((resolve) => { timeout = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForProcessesToStop(
  processIds: readonly number[],
  timeoutMs: number,
  inspectProcess: (pid: number) => ProcessState,
) {
  const pending = [...new Set(processIds)];
  const deadline = Date.now() + timeoutMs;
  while (pending.some((pid) => inspectProcess(pid) !== "dead")) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, remaining)));
  }
  return true;
}

export type SupervisedDesktopServer = Readonly<{
  process: UtilityProcessLike;
  spawned: Promise<number>;
  exit: Promise<ProcessExit>;
  stop(): Promise<void>;
}>;

export type SupervisedDesktopServerInput = {
  fork: UtilityProcessFork;
  boundary: DesktopRuntimeBoundary;
  launch: DesktopLaunch;
  listDescendants?: (rootPid: number) => Promise<number[]>;
  sendSignal?: typeof process.kill;
  inspectProcess?: (pid: number) => ProcessState;
  spawnTimeoutMs?: number;
  gracefulTimeoutMs?: number;
  forceTimeoutMs?: number;
  platform?: NodeJS.Platform;
  terminateWindowsTree?: (rootPid: number, force: boolean) => Promise<void>;
};

function validUtilityProcessId(processId: number | undefined): processId is number {
  return Number.isSafeInteger(processId) && Number(processId) > 0;
}

function waitForUtilityProcessSpawn(
  child: UtilityProcessLike,
  exit: Promise<ProcessExit>,
  timeoutMs: number,
) {
  if (validUtilityProcessId(child.pid)) return Promise.resolve(child.pid);
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => finish(() => {
      reject(new Error("Rangabot's local server process did not spawn in time."));
    }), timeoutMs);
    child.once("spawn", () => finish(() => {
      const processId = child.pid;
      if (validUtilityProcessId(processId)) resolve(processId);
      else reject(new Error("Rangabot's local server did not expose a valid process identity after spawning."));
    }));
    void exit.then(({ code }) => finish(() => {
      reject(new Error(`Rangabot's local server exited before spawning (exit ${code}).`));
    }));
  });
}

export function startSupervisedDesktopServer(input: SupervisedDesktopServerInput): SupervisedDesktopServer {
  const child = input.fork(input.boundary.serverEntrypoint, [], {
    cwd: input.boundary.resourceRoot,
    env: { ...input.launch.environment },
    execArgv: [],
    stdio: "pipe",
    serviceName: "Rangabot Local Server",
    allowLoadingUnsignedLibraries: false,
    disclaim: false,
  });
  drain(child.stdout);
  drain(child.stderr);

  const exit = new Promise<ProcessExit>((resolve) => child.once("exit", (code) => resolve(Object.freeze({ code }))));
  const spawned = waitForUtilityProcessSpawn(child, exit, input.spawnTimeoutMs ?? 10_000);
  const listDescendants = input.listDescendants ?? listMacProcessDescendants;
  const sendSignal = input.sendSignal ?? process.kill.bind(process);
  const inspectProcess = input.inspectProcess ?? inspectLocalProcess;
  let stopping: Promise<void> | undefined;

  const stop = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      const rootPid = child.pid;
      const gracefulTimeoutMs = input.gracefulTimeoutMs ?? 2_500;
      const forceTimeoutMs = input.forceTimeoutMs ?? 1_000;
      if (!rootPid) {
        child.kill();
        if (!await waitForExit(exit, gracefulTimeoutMs)) {
          child.kill();
          if (!await waitForExit(exit, forceTimeoutMs)) {
            throw new Error("Rangabot's local server process did not terminate.");
          }
        }
        return;
      }
      if ((input.platform ?? process.platform) === "win32") {
        const terminateTree = input.terminateWindowsTree ?? terminateWindowsProcessTree;
        await terminateTree(rootPid, false);
        if (await waitForExit(exit, gracefulTimeoutMs)) return;
        await terminateTree(rootPid, true);
        if (!await waitForExit(exit, forceTimeoutMs)) {
          throw new Error("Rangabot's local server process tree did not terminate.");
        }
        return;
      }
      let descendants: number[] = [];
      try { descendants = await listDescendants(rootPid); }
      catch { descendants = []; }
      const knownDescendants = new Set(descendants);
      for (const pid of knownDescendants) signalIfAlive(pid, "SIGTERM", sendSignal);
      child.kill();
      const rootStopped = await waitForExit(exit, gracefulTimeoutMs);
      const descendantsStopped = await waitForProcessesToStop(
        [...knownDescendants],
        gracefulTimeoutMs,
        inspectProcess,
      );
      if (rootStopped && descendantsStopped) return;

      if (!rootStopped) {
        try {
          for (const pid of await listDescendants(rootPid)) knownDescendants.add(pid);
        } catch { /* Retain the descendants captured before shutdown. */ }
      }
      for (const pid of knownDescendants) {
        if (inspectProcess(pid) !== "dead") signalIfAlive(pid, "SIGKILL", sendSignal);
      }
      if (!rootStopped) signalIfAlive(rootPid, "SIGKILL", sendSignal);
      const rootForceStopped = rootStopped || await waitForExit(exit, forceTimeoutMs);
      const descendantsForceStopped = await waitForProcessesToStop(
        [...knownDescendants],
        forceTimeoutMs,
        inspectProcess,
      );
      if (!rootForceStopped || !descendantsForceStopped) {
        throw new Error("Rangabot's local server process tree did not terminate.");
      }
    })();
    return stopping;
  };

  return Object.freeze({ process: child, spawned, exit, stop });
}

export const DESKTOP_RUNTIME_LEASE_FILENAME = "rangabot.db-runtime.lock";

export function desktopRuntimeLeasePath(dataRoot: string) {
  return join(dataRoot, DESKTOP_RUNTIME_LEASE_FILENAME);
}

type AcquireDesktopRuntimeLease = (options: RuntimeLeaseOptions) => RuntimeLease;

export type LeasedSupervisedDesktopServer = SupervisedDesktopServer & Readonly<{
  leasePath: string;
  processId: number;
}>;

/**
 * Acquires the single-writer lease before forking the database-owning utility
 * process. The lease is released only after the process supervisor confirms
 * that the owned process tree stopped; failed termination deliberately keeps
 * the lease in place so another writer cannot start.
 */
export async function startLeasedDesktopServer(
  input: SupervisedDesktopServerInput & { acquireLease?: AcquireDesktopRuntimeLease },
): Promise<LeasedSupervisedDesktopServer> {
  const leasePath = desktopRuntimeLeasePath(input.boundary.dataRoot);
  const lease = (input.acquireLease ?? acquireRuntimeLease)({
    path: leasePath,
    trustedRoot: input.boundary.dataRoot,
    role: "app",
  });
  let supervised: SupervisedDesktopServer | undefined;
  let processId = 0;
  try {
    supervised = startSupervisedDesktopServer(input);
    processId = await supervised.spawned;
    lease.registerRuntimeProcess(processId);
  } catch (error) {
    if (!supervised) {
      lease.release();
      throw error;
    }
    try {
      await supervised.stop();
    } catch (stopError) {
      throw new AggregateError(
        [error, stopError],
        "Rangabot could not safely finish a failed desktop server start; its runtime lease was retained.",
      );
    }
    lease.release();
    throw error;
  }

  let stopping: Promise<void> | undefined;
  const stop = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      await supervised.stop();
      if (!lease.release()) {
        throw new Error("Rangabot's desktop runtime lease ownership changed before shutdown completed.");
      }
    })();
    return stopping;
  };
  return Object.freeze({ ...supervised, leasePath, processId, stop });
}
