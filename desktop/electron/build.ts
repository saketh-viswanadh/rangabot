import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const electronSourceRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(electronSourceRoot, "../..");
const outputRoot = resolve(projectRoot, "desktop", "out", "electron-app");
const compiledShellRoot = resolve(outputRoot, "desktop", "electron");
const typescriptCli = resolve(projectRoot, "node_modules", "typescript", "bin", "tsc");

rmSync(outputRoot, { force: true, recursive: true });
const compilation = spawnSync(process.execPath, [typescriptCli, "--project", resolve(electronSourceRoot, "tsconfig.json")], {
  cwd: projectRoot,
  env: { ...process.env, NODE_ENV: "production" },
  stdio: "inherit",
});
if (compilation.error) throw compilation.error;
if (compilation.signal || compilation.status !== 0) {
  throw new Error(`Electron shell compilation failed${compilation.signal ? ` with ${compilation.signal}` : ""}.`);
}
mkdirSync(compiledShellRoot, { recursive: true });
copyFileSync(resolve(electronSourceRoot, "preload.cjs"), resolve(compiledShellRoot, "preload.cjs"));
console.log(`Compiled Electron main: ${resolve(compiledShellRoot, "main.js")}`);
