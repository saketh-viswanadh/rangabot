import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { totalmem } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ensurePrivateDirectory, ensurePrivateFile } from "../lib/private-storage.ts";
import { runtimePaths } from "../lib/runtime-paths.ts";

type Registry = { models: Array<{ id: string; label: string; tier: string; minimumMemoryGb: number; recommendedContextTokens: number; uses: string[]; notes: string }>; embeddingModels: Array<{ id: string; label: string }> };
const registry = JSON.parse(readFileSync(resolve(runtimePaths.resourceRoot, "config", "models.json"), "utf8")) as Registry;
const memoryGb = Math.round(totalmem() / 1024 ** 3);
const modelArgument = process.argv.find((argument) => argument.startsWith("--model="))?.slice("--model=".length);
const skipPull = process.argv.includes("--skip-pull");
const terminal = input.isTTY && output.isTTY ? createInterface({ input, output }) : null;

console.log(`\nRangabot local setup · ${memoryGb} GB system memory\n`);
registry.models.forEach((model, index) => {
  const fit = memoryGb >= model.minimumMemoryGb ? "recommended for this machine" : `needs about ${model.minimumMemoryGb} GB`;
  console.log(`${index + 1}. ${model.label} (${model.tier}) — ${fit}\n   ${model.notes}`);
});

const answer = terminal ? await terminal.question(`\nChoose a chat model [1]: `) : "1";
const selected = registry.models.find((model) => model.id === modelArgument)
  ?? registry.models[Math.max(0, Math.min(registry.models.length - 1, Number(answer || "1") - 1))]
  ?? registry.models[0];
const embedding = registry.embeddingModels[0];
if (!selected || !embedding) throw new Error("The model registry has no usable chat or embedding model.");
const shouldPull = !skipPull && terminal
  ? /^y(?:es)?$/i.test(await terminal.question(`Download ${selected.id} and ${embedding.id} with Ollama now? [y/N]: `))
  : false;
terminal?.close();

try { execFileSync("ollama", ["--version"], { stdio: "ignore" }); }
catch {
  console.error("Ollama was not found. Install it from https://ollama.com/ and run npm run setup again.");
  process.exit(1);
}

if (shouldPull) {
  for (const model of [selected.id, embedding.id]) {
    console.log(`\nDownloading ${model}…`);
    const result = spawnSync("ollama", ["pull", model], { stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

const envPath = resolve(runtimePaths.resourceRoot, ".env.local");
if (existsSync(envPath)) {
  ensurePrivateFile(envPath);
  console.log("\n.env.local already exists; setup did not overwrite it.");
} else {
  writeFileSync(envPath, [
    "OLLAMA_BASE_URL=http://127.0.0.1:11434",
    `OLLAMA_MODEL=${selected.id}`,
    `OLLAMA_NUM_CTX=${selected.recommendedContextTokens}`,
    `OLLAMA_EMBED_MODEL=${embedding.id}`,
    "KNOWLEDGE_BUDGET_BYTES=4294967296",
    "",
  ].join("\n"), { mode: 0o600 });
  console.log("\nCreated private .env.local configuration.");
}

for (const directory of [
  runtimePaths.artifactsRoot,
  runtimePaths.knowledgeInbox,
  runtimePaths.knowledgeIndexes,
  runtimePaths.knowledgeProcessed,
  runtimePaths.knowledgeBackups,
]) ensurePrivateDirectory(directory);
console.log("Initialized the private Knowledge Vault.");
console.log("\nNext: add documents to data/knowledge/inbox, run npm run knowledge:ingest, then npm run dev.\n");
