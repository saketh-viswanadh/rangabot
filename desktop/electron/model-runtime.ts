import { spawn, type ChildProcess } from "node:child_process";
import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { DesktopRuntimeBoundary } from "./resource-boundary.ts";

const START_TIMEOUT_MS = 30_000;

export type ManagedModelRuntime = Readonly<{ baseUrl: string; process: ChildProcess; stop(): Promise<void> }>;

async function waitUntilReady(baseUrl: string, child: ChildProcess, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Rangabot's model runtime exited during startup (exit ${child.exitCode}).`);
    try {
      const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch { /* The private runtime is still starting. */ }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Rangabot's model runtime did not become ready in time.");
}

export function selectManagedModelStore(input: { privateModelsRoot: string; standardModelsRoot?: string }) {
  const privateRoot = resolve(input.privateModelsRoot);
  if (!isAbsolute(input.privateModelsRoot) || privateRoot !== input.privateModelsRoot) throw new Error("Rangabot's private model store path is invalid.");
  if (input.standardModelsRoot) {
    const standardRoot = resolve(input.standardModelsRoot);
    if (!isAbsolute(input.standardModelsRoot) || standardRoot !== input.standardModelsRoot) throw new Error("The standard model store path is invalid.");
    try {
      const status = lstatSync(standardRoot);
      const manifests = lstatSync(join(standardRoot, "manifests"));
      const blobs = lstatSync(join(standardRoot, "blobs"));
      if (!status.isSymbolicLink() && status.isDirectory() && !manifests.isSymbolicLink() && manifests.isDirectory()
        && !blobs.isSymbolicLink() && blobs.isDirectory() && realpathSync(standardRoot) === standardRoot
        && (typeof process.getuid !== "function" || statSync(standardRoot).uid === process.getuid())) return standardRoot;
    } catch { /* Missing or unsafe external store falls back to app-private storage. */ }
  }
  mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  return realpathSync(privateRoot);
}

export async function startManagedModelRuntime(input: { boundary: DesktopRuntimeBoundary; port: number; standardModelsRoot?: string }): Promise<ManagedModelRuntime> {
  const runtimeRoot = join(input.boundary.resourceRoot, "runtime", "ollama");
  const executable = join(runtimeRoot, "ollama");
  const status = lstatSync(executable);
  if (status.isSymbolicLink() || !status.isFile()) throw new Error("Rangabot's packaged model runtime is unavailable.");
  const modelsRoot = selectManagedModelStore({
    privateModelsRoot: join(input.boundary.dataRoot, "models"),
    standardModelsRoot: input.standardModelsRoot,
  });
  const baseUrl = `http://127.0.0.1:${input.port}`;
  const child: ChildProcess = spawn(executable, ["serve"], {
    cwd: runtimeRoot,
    env: {
      HOME: input.boundary.dataRoot,
      OLLAMA_HOST: baseUrl,
      OLLAMA_MODELS: modelsRoot,
      OLLAMA_KEEP_ALIVE: "5m",
      OLLAMA_MAX_LOADED_MODELS: "1",
      OLLAMA_NUM_PARALLEL: "1",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      NODE_ENV: "production",
    },
    stdio: "ignore",
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const stop = async () => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 3_000))]);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  };
  try { await waitUntilReady(baseUrl, child, START_TIMEOUT_MS); }
  catch (error) { await stop(); throw error; }
  return Object.freeze({ baseUrl, process: child, stop });
}
