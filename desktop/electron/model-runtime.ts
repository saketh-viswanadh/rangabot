import { execFile, spawn, type ChildProcess } from "node:child_process";
import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { DesktopRuntimeBoundary } from "./resource-boundary.ts";

const START_TIMEOUT_MS = 30_000;

export function managedModelExecutableName(platform: NodeJS.Platform = process.platform) {
  return platform === "win32" ? "ollama.exe" : "ollama";
}

export function managedModelEnvironment(input: {
  boundary: DesktopRuntimeBoundary;
  baseUrl: string;
  modelsRoot: string;
  runtimeRoot: string;
  platform?: NodeJS.Platform;
  baseEnvironment?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const platform = input.platform ?? process.platform;
  const source = input.baseEnvironment ?? process.env;
  const environment: NodeJS.ProcessEnv = {
    HOME: input.boundary.dataRoot,
    OLLAMA_HOST: input.baseUrl,
    OLLAMA_MODELS: input.modelsRoot,
    OLLAMA_KEEP_ALIVE: "5m",
    OLLAMA_MAX_LOADED_MODELS: "1",
    OLLAMA_NUM_PARALLEL: "1",
    NODE_ENV: "production",
  };
  if (platform === "win32") {
    const systemRoot = source.SystemRoot ?? source.SYSTEMROOT ?? source.WINDIR;
    if (!systemRoot) throw new Error("Windows SystemRoot is unavailable for Rangabot's local model runtime.");
    environment.SystemRoot = systemRoot;
    environment.WINDIR = systemRoot;
    environment.USERPROFILE = input.boundary.dataRoot;
    environment.LOCALAPPDATA = input.boundary.dataRoot;
    environment.APPDATA = input.boundary.dataRoot;
    environment.TEMP = input.boundary.tempRoot;
    environment.TMP = input.boundary.tempRoot;
    environment.PATH = `${input.runtimeRoot};${join(systemRoot, "System32")};${systemRoot}`;
  } else {
    environment.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
    environment.TMPDIR = input.boundary.tempRoot;
  }
  return environment;
}

export type ManagedModelRuntime = Readonly<{ baseUrl: string; process: ChildProcess; stop(): Promise<void> }>;

export async function terminateWindowsModelProcessTree(processId: number, force: boolean) {
  await new Promise<void>((resolve) => {
    execFile("taskkill.exe", ["/PID", String(processId), "/T", ...(force ? ["/F"] : [])], {
      windowsHide: true,
      timeout: 5_000,
    }, () => resolve());
  });
}

export async function stopManagedModelProcess(input: {
  child: Pick<ChildProcess, "exitCode" | "pid" | "kill">;
  exited: Promise<void>;
  platform?: NodeJS.Platform;
  terminateWindowsTree?: (processId: number, force: boolean) => Promise<void>;
  gracefulTimeoutMs?: number;
}) {
  if (input.child.exitCode !== null) return;
  const platform = input.platform ?? process.platform;
  const timeoutMs = input.gracefulTimeoutMs ?? 3_000;
  const wait = () => Promise.race([
    input.exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
  if (platform === "win32" && input.child.pid) {
    const terminateTree = input.terminateWindowsTree ?? terminateWindowsModelProcessTree;
    await terminateTree(input.child.pid, false);
    if (await wait()) return;
    await terminateTree(input.child.pid, true);
    if (!await wait()) throw new Error("Rangabot's model runtime process tree did not terminate.");
    return;
  }
  input.child.kill("SIGTERM");
  if (await wait()) return;
  input.child.kill("SIGKILL");
  await input.exited;
}

async function waitUntilReady(baseUrl: string, child: ChildProcess, timeoutMs: number, getSpawnError: () => Error | undefined) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const spawnError = getSpawnError();
    if (spawnError) throw new Error(`Rangabot's model runtime could not start: ${spawnError.message}`);
    if (child.exitCode !== null) throw new Error(`Rangabot's model runtime exited during startup (exit ${child.exitCode}).`);
    try {
      const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch { /* The private runtime is still starting. */ }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Rangabot's model runtime did not become ready in time.");
}

export function selectManagedModelStore(input: { privateModelsRoot: string; standardModelsRoot?: string; platform?: NodeJS.Platform }) {
  const platform = input.platform ?? process.platform;
  const privateRoot = resolve(input.privateModelsRoot);
  if (!isAbsolute(input.privateModelsRoot) || privateRoot !== input.privateModelsRoot) throw new Error("Rangabot's private model store path is invalid.");
  if (input.standardModelsRoot) {
    const standardRoot = resolve(input.standardModelsRoot);
    if (!isAbsolute(input.standardModelsRoot) || standardRoot !== input.standardModelsRoot) throw new Error("The standard model store path is invalid.");
    try {
      const status = lstatSync(standardRoot);
      const manifests = lstatSync(join(standardRoot, "manifests"));
      const blobs = lstatSync(join(standardRoot, "blobs"));
      const canonicalRoot = realpathSync(standardRoot);
      const canonicalMatches = platform === "win32"
        ? canonicalRoot.toLowerCase() === standardRoot.toLowerCase()
        : canonicalRoot === standardRoot;
      if (!status.isSymbolicLink() && status.isDirectory() && !manifests.isSymbolicLink() && manifests.isDirectory()
        && !blobs.isSymbolicLink() && blobs.isDirectory() && canonicalMatches
        && (typeof process.getuid !== "function" || statSync(standardRoot).uid === process.getuid())) return standardRoot;
    } catch { /* Missing or unsafe external store falls back to app-private storage. */ }
  }
  mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  const privateStatus = lstatSync(privateRoot);
  const canonicalPrivateRoot = realpathSync(privateRoot);
  const privateCanonicalMatches = platform === "win32"
    ? canonicalPrivateRoot.toLowerCase() === privateRoot.toLowerCase()
    : canonicalPrivateRoot === privateRoot;
  const privateOwnership = statSync(privateRoot);
  if (privateStatus.isSymbolicLink() || !privateStatus.isDirectory() || !privateCanonicalMatches
    || (typeof process.getuid === "function" && (privateOwnership.uid !== process.getuid() || (privateOwnership.mode & 0o077) !== 0))) {
    throw new Error("Rangabot's private model store is not an owner-private real directory.");
  }
  return canonicalPrivateRoot;
}

export async function startManagedModelRuntime(input: { boundary: DesktopRuntimeBoundary; port: number; standardModelsRoot?: string }): Promise<ManagedModelRuntime> {
  const runtimeRoot = join(input.boundary.resourceRoot, "runtime", "ollama");
  const executable = join(runtimeRoot, managedModelExecutableName());
  const status = lstatSync(executable);
  if (status.isSymbolicLink() || !status.isFile()) throw new Error("Rangabot's packaged model runtime is unavailable.");
  const modelsRoot = selectManagedModelStore({
    privateModelsRoot: join(input.boundary.dataRoot, "models"),
    standardModelsRoot: input.standardModelsRoot,
    platform: process.platform,
  });
  const baseUrl = `http://127.0.0.1:${input.port}`;
  const child: ChildProcess = spawn(executable, ["serve"], {
    cwd: runtimeRoot,
    env: managedModelEnvironment({ boundary: input.boundary, baseUrl, modelsRoot, runtimeRoot }),
    stdio: "ignore",
    windowsHide: true,
  });
  let spawnError: Error | undefined;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", (error) => { spawnError = error; resolve(); });
  });
  const stop = async () => {
    await stopManagedModelProcess({ child, exited });
  };
  try { await waitUntilReady(baseUrl, child, START_TIMEOUT_MS, () => spawnError); }
  catch (error) { await stop(); throw error; }
  return Object.freeze({ baseUrl, process: child, stop });
}
