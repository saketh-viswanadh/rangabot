import { createServer } from "node:net";
import { request } from "node:http";
import {
  DESKTOP_READINESS_CHALLENGE_HEADER,
  DESKTOP_READINESS_PATH,
  DESKTOP_READINESS_PROCESS_HEADER,
  DESKTOP_READINESS_PROOF_HEADER,
  verifyDesktopReadinessProof,
  type DesktopReadinessCapability,
} from "../../lib/desktop-startup-security.ts";

export const DESKTOP_LOOPBACK_HOST = "127.0.0.1";

export class DesktopServerStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopServerStartupError";
  }
}

export async function reserveVerifiedLoopbackPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: DESKTOP_LOOPBACK_HOST, port: 0, exclusive: true }, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== DESKTOP_LOOPBACK_HOST || address.family !== "IPv4") {
    server.close();
    throw new DesktopServerStartupError("The operating system did not reserve a private IPv4 loopback port.");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

export function probeDesktopServer(input: {
  port: number;
  readiness: DesktopReadinessCapability;
  expectedProcessId: number;
  timeoutMs?: number;
}) {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ready);
    };
    const localRequest = request({
      host: DESKTOP_LOOPBACK_HOST,
      port: input.port,
      path: DESKTOP_READINESS_PATH,
      method: "POST",
      timeout: input.timeoutMs ?? 750,
      headers: {
        Host: `${DESKTOP_LOOPBACK_HOST}:${input.port}`,
        "Content-Length": "0",
        [DESKTOP_READINESS_CHALLENGE_HEADER]: input.readiness.challenge,
      },
    }, (response) => {
      response.resume();
      finish(response.statusCode === 204 && verifyDesktopReadinessProof({
        challenge: input.readiness.challenge,
        secret: input.readiness.secret,
        expectedProcessId: input.expectedProcessId,
        reportedProcessId: response.headers[DESKTOP_READINESS_PROCESS_HEADER.toLowerCase()] as string | undefined,
        proof: response.headers[DESKTOP_READINESS_PROOF_HEADER.toLowerCase()] as string | undefined,
      }));
    });
    localRequest.once("timeout", () => {
      localRequest.destroy();
      finish(false);
    });
    localRequest.once("error", () => finish(false));
    localRequest.end();
  });
}

function delay(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function waitForDesktopServer(input: {
  port: number;
  readiness: DesktopReadinessCapability;
  expectedProcessId: number;
  timeoutMs?: number;
  intervalMs?: number;
  probe?: (input: {
    port: number;
    readiness: DesktopReadinessCapability;
    expectedProcessId: number;
  }) => Promise<boolean>;
  exited?: Promise<unknown>;
  signal?: AbortSignal;
}) {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const intervalMs = input.intervalMs ?? 100;
  const probe = input.probe ?? probeDesktopServer;
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  input.exited?.then(() => { exited = true; }, () => { exited = true; });

  while (Date.now() < deadline) {
    input.signal?.throwIfAborted();
    if (exited) throw new DesktopServerStartupError("Rangabot's local server stopped during startup.");
    if (await probe({
      port: input.port,
      readiness: input.readiness,
      expectedProcessId: input.expectedProcessId,
    })) return;
    await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())), input.signal);
  }
  throw new DesktopServerStartupError("Rangabot's local server did not become healthy before the private startup timeout.");
}
