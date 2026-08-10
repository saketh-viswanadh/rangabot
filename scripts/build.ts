import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const nextCli = resolve(process.cwd(), "node_modules", "next", "dist", "bin", "next");
const result = spawnSync(process.execPath, [nextCli, "build"], {
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: process.env.NEXT_TELEMETRY_DISABLED ?? "1" },
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.signal) {
  console.error(`Rangabot's production build was stopped by ${result.signal}.`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
