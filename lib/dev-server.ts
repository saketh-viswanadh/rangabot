import { createLocalSessionSecret, issueLocalBootstrapToken } from "./local-session-token.ts";

const defaultLocalPort = 3000;

export function localServerPort(environment: Record<string, string | undefined> = process.env) {
  const configured = environment.PORT;
  if (configured === undefined || configured === "") return defaultLocalPort;
  if (!/^[0-9]{1,5}$/.test(configured)) throw new Error("PORT must be a local TCP port between 1024 and 65535.");
  const port = Number(configured);
  if (port < 1024 || port > 65_535) throw new Error("PORT must be a local TCP port between 1024 and 65535.");
  return port;
}

export function localBootstrapUrl(bootstrapToken: string, port = defaultLocalPort) {
  if (!/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(bootstrapToken)) {
    throw new Error("A valid one-launch bootstrap capability is required.");
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error("A valid local TCP port is required.");
  }
  const url = new URL(`/bootstrap`, `http://127.0.0.1:${port}`);
  url.hash = new URLSearchParams({ bootstrap: bootstrapToken }).toString();
  return url.href;
}

export function localServerEnvironment(environment: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const sessionSecret = createLocalSessionSecret();
  return {
    ...environment,
    NEXT_TELEMETRY_DISABLED: environment.NEXT_TELEMETRY_DISABLED ?? "1",
    RANGABOT_SESSION_SECRET: sessionSecret,
    RANGABOT_BOOTSTRAP_TOKEN: issueLocalBootstrapToken(sessionSecret),
  };
}

export function devServerEnvironment(platform: NodeJS.Platform, environment: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const local = localServerEnvironment(environment);
  if (platform !== "darwin") return local;
  return {
    ...local,
    WATCHPACK_POLLING: environment.WATCHPACK_POLLING ?? "true",
    WATCHPACK_POLLING_INTERVAL: environment.WATCHPACK_POLLING_INTERVAL ?? "1000",
  };
}
