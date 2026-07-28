import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const envPath = resolve(".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}
const major = Number(process.versions.node.split(".")[0]);
checks.push({ name: "Node.js", ok: major >= 24, detail: `v${process.versions.node}; Rangabot requires Node 24+` });
checks.push({ name: "Environment", ok: existsSync(envPath), detail: existsSync(envPath) ? ".env.local found" : "Run npm run setup or copy .env.example" });
checks.push({ name: "Knowledge inbox", ok: existsSync(resolve("data/knowledge/inbox")), detail: "data/knowledge/inbox" });

try {
  const response = await fetch(`${process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434"}/api/tags`, { signal: AbortSignal.timeout(2_500) });
  const body = await response.json() as { models?: Array<{ name: string }> };
  const configured = process.env.OLLAMA_MODEL ?? readFileSync(resolve(".env.example"), "utf8").match(/^OLLAMA_MODEL=(.+)$/m)?.[1] ?? "llama3.2:3b";
  const installed = body.models?.some((model) => model.name === configured || model.name.startsWith(`${configured}:`)) ?? false;
  checks.push({ name: "Ollama", ok: response.ok, detail: response.ok ? "running locally" : `HTTP ${response.status}` });
  checks.push({ name: "Chat model", ok: installed, detail: installed ? `${configured} installed` : `${configured} missing; run ollama pull ${configured}` });
} catch {
  checks.push({ name: "Ollama", ok: false, detail: "not reachable at the configured loopback address" });
}

for (const check of checks) console.log(`${check.ok ? "PASS" : "WARN"}  ${check.name}: ${check.detail}`);
if (checks.some((check) => !check.ok)) process.exitCode = 1;
