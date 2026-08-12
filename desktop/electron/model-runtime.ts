import { spawn, type ChildProcess } from "node:child_process";
import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
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

export async function startManagedModelRuntime(input: { boundary: DesktopRuntimeBoundary; port: number }): Promise<ManagedModelRuntime> {
  const runtimeRoot = join(input.boundary.resourceRoot, "runtime", "ollama");
  const executable = join(runtimeRoot, "ollama");
  const status = lstatSync(executable);
  if (status.isSymbolicLink() || !status.isFile()) throw new Error("Rangabot's packaged model runtime is unavailable.");
  const modelsRoot = join(input.boundary.dataRoot, "models");
  mkdirSync(modelsRoot, { recursive: true, mode: 0o700 });
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
