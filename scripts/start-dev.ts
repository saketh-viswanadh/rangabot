import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { devServerEnvironment } from "../lib/dev-server.ts";

const nextCli = resolve(process.cwd(), "node_modules", "next", "dist", "bin", "next");
const child = spawn(process.execPath, [nextCli, "dev", "--hostname", "127.0.0.1"], {
  env: devServerEnvironment(process.platform) as NodeJS.ProcessEnv,
  stdio: "inherit",
});

child.once("error", (error) => {
  console.error(`Could not start Rangabot: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
