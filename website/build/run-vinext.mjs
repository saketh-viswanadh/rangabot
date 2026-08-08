import { spawn } from "node:child_process";

const command = process.platform === "win32" ? "vinext.cmd" : "vinext";
const child = spawn(command, process.argv.slice(2), {
  env: {
    ...process.env,
    WRANGLER_LOG_PATH: ".wrangler/wrangler.log",
  },
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.once("error", (error) => {
  console.error(`Unable to start ${command}: ${error.message}`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`${command} stopped after receiving ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
