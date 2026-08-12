import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { getConfiguredChatModel, getLocalOllamaBaseUrl } from "../lib/local-runtime-config.ts";
import { runtimePaths } from "../lib/runtime-paths.ts";

type Check = { name: string; ok: boolean; detail: string; required?: boolean };
const checks: Check[] = [];
const envPath = resolve(runtimePaths.resourceRoot, ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}
const major = Number(process.versions.node.split(".")[0]);
checks.push({ name: "Node.js", ok: major >= 24, detail: `v${process.versions.node}; Rangabot requires Node 24+` });
checks.push({ name: "Environment", ok: existsSync(envPath), detail: existsSync(envPath) ? ".env.local found" : "Run npm run setup or copy .env.example" });
checks.push({ name: "Knowledge inbox", ok: existsSync(runtimePaths.knowledgeInbox), detail: runtimePaths.knowledgeInbox });
checks.push({ name: "Artifact output", ok: existsSync(runtimePaths.artifactsRoot), detail: `${runtimePaths.artifactsRoot}; run npm run setup if missing` });
const officeAvailable = spawnSync("soffice", ["--version"], { stdio: "ignore" }).status === 0;
const popplerAvailable = spawnSync("pdftoppm", ["-v"], { stdio: "ignore" }).status === 0;
checks.push({ name: "Word preview", ok: officeAvailable && popplerAvailable, required: false, detail: officeAvailable && popplerAvailable ? "LibreOffice and Poppler available" : "optional; install LibreOffice and Poppler for rendered page previews" });

try {
  const response = await fetch(`${getLocalOllamaBaseUrl()}/api/tags`, { signal: AbortSignal.timeout(2_500) });
  const body = await response.json() as { models?: Array<{ name: string }> };
  const configured = getConfiguredChatModel();
  const installed = body.models?.some((model) => model.name === configured || model.name.startsWith(`${configured}:`)) ?? false;
  checks.push({ name: "Ollama", ok: response.ok, detail: response.ok ? "running locally" : `HTTP ${response.status}` });
  checks.push({ name: "Chat model", ok: installed, detail: installed ? `${configured} installed` : `${configured} missing; run ollama pull ${configured}` });
} catch {
  checks.push({ name: "Ollama", ok: false, detail: "not reachable at the configured loopback address" });
}

for (const check of checks) console.log(`${check.ok ? "PASS" : "WARN"}  ${check.name}: ${check.detail}`);
if (checks.some((check) => !check.ok && check.required !== false)) process.exitCode = 1;
