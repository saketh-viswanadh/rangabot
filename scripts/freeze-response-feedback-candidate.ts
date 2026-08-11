import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  RESPONSE_FEEDBACK_CANDIDATE_MANIFEST_PATH,
  collectResponseFeedbackCandidateFiles,
  deriveResponseFeedbackCandidate,
} from "../lib/response-feedback-candidate.ts";

const approvedBaseCommit = "2f24271dc455e518861d230edbfb6743d0131756";
if (process.argv.length !== 3 || process.argv[2] !== `--base=${approvedBaseCommit}`) {
  console.error(`Usage: node --experimental-strip-types scripts/freeze-response-feedback-candidate.ts --base=${approvedBaseCommit}`);
  process.exit(1);
}

const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim().toLowerCase();
const lineage = spawnSync("git", ["merge-base", "--is-ancestor", approvedBaseCommit, head], { stdio: "ignore" });
if (lineage.status !== 0) throw new Error("The response-feedback manifest can be frozen only on the approved baseline or a descendant.");

const packageRecord = JSON.parse(readFileSync("package.json", "utf8")) as { version?: unknown };
if (typeof packageRecord.version !== "string") throw new Error("package.json must contain a source version.");
const files = collectResponseFeedbackCandidateFiles();
const derived = deriveResponseFeedbackCandidate(approvedBaseCommit, packageRecord.version, files);
const manifest = {
  schemaVersion: 1,
  baseCommit: approvedBaseCommit,
  sourceVersion: packageRecord.version,
  manifestSha256: derived.manifestSha256,
  candidateBuildId: derived.candidateBuildId,
  build: derived.build,
  files: derived.files,
};
const destination = resolve(RESPONSE_FEEDBACK_CANDIDATE_MANIFEST_PATH);
if (lstatSync(destination).isSymbolicLink()) throw new Error("The candidate manifest must not be a symbolic link.");
writeFileSync(destination, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
console.log(`Frozen ${manifest.build} with source manifest ${manifest.manifestSha256}.`);
