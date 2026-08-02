import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { MasteryEvidenceRegistry } from "../lib/mastery-tree.ts";

const registry = JSON.parse(readFileSync(resolve("content/mastery-evidence.json"), "utf8")) as MasteryEvidenceRegistry;
let ancestors = 0;
for (const entry of registry.entries) {
  try {
    execFileSync("git", ["cat-file", "-e", `${entry.mergeCommit}^{commit}`], { stdio: "ignore" });
  } catch {
    throw new Error(`${entry.id} references ${entry.mergeCommit}, which is absent from this repository.`);
  }
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", entry.mergeCommit, "HEAD"], { stdio: "ignore" });
    ancestors += 1;
  } catch { /* A historical merged PR can survive a later history rewrite without being a current ancestor. */ }
}
console.log(`Verified ${registry.entries.length} merged-PR commits exist locally; ${ancestors} are direct ancestors of HEAD and ${registry.entries.length - ancestors} are retained historical merges.`);
