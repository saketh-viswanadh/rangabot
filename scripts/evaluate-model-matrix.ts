import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { totalmem } from "node:os";
import { resolve } from "node:path";
import modelRegistry from "../config/models.json" with { type: "json" };
import { ensurePrivateDirectory, writePrivateJsonFileAtomic } from "../lib/private-storage.ts";
import {
  assessConversationEvaluation,
  type ConversationEvaluationAssessment,
  type ConversationEvaluationAssessmentInput,
} from "../lib/conversation-evaluation-assessment.ts";
import { acquireProfileMaintenanceBinding } from "../lib/profile-maintenance.ts";

type Profile = (typeof modelRegistry.models)[number];
type ConversationSummary = ConversationEvaluationAssessmentInput & {
  suite: { name: string; version: string };
  totals: ConversationEvaluationAssessmentInput["totals"] & { passRate: number };
  critical: ConversationEvaluationAssessmentInput["critical"] & { passRate: number | null };
  averageLatencyMs: number | null;
};

const option = (name: string) => process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
const full = process.argv.includes("--full");
const listOnly = process.argv.includes("--list");
const allowUndersizedMemory = process.argv.includes("--allow-undersized-memory");
const requested = option("models")?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
const requestedCaseIds = option("ids")?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
const memoryGb = Math.round(totalmem() / 1024 ** 3);
if (full && requestedCaseIds.length) throw new Error("Use either --full or --ids, not both.");

function installedModels() {
  const output = execFileSync("ollama", ["list"], { encoding: "utf8" });
  return new Set(output.split(/\r?\n/).slice(1).map((line) => line.trim().split(/\s+/)[0]).filter(Boolean));
}

const installed = installedModels();
const profiles = (requested.length
  ? requested.map((id) => modelRegistry.models.find((profile) => profile.id === id) ?? (() => { throw new Error(`Unknown registry model: ${id}`); })())
  : modelRegistry.models.filter((profile) => installed.has(profile.id))) as Profile[];

if (!profiles.length) throw new Error("No requested registered chat models are installed.");
for (const profile of profiles) {
  if (!installed.has(profile.id)) throw new Error(`${profile.id} is not installed. Run ollama pull ${profile.id} first.`);
  const fit = memoryGb >= profile.minimumMemoryGb ? "fits registry guidance" : `below ${profile.minimumMemoryGb} GB guidance`;
  console.log(`${profile.id} · ${profile.recommendedContextTokens} context tokens · ${fit}`);
}
if (listOnly) process.exit(0);

const undersized = profiles.filter((profile) => memoryGb < profile.minimumMemoryGb);
if (undersized.length && !allowUndersizedMemory) {
  throw new Error(`${undersized.map((profile) => profile.id).join(", ")} exceeds this ${memoryGb} GB machine's registry guidance. Rerun with --allow-undersized-memory only after closing memory-heavy apps.`);
}
const profileMaintenance = acquireProfileMaintenanceBinding({ label: "Conversation model matrix evaluation" });

const matrixStartedAt = new Date().toISOString();
const matrix: Array<{ model: string; contextTokens: number; result: string; exitCode: number; summary?: ConversationSummary; assessment?: ConversationEvaluationAssessment }> = [];
for (const profile of profiles) {
  profileMaintenance.assertCurrent();
  console.log(`\n=== ${profile.label} (${profile.id}) ===`);
  spawnSync("ollama", ["stop", profile.id], { stdio: "ignore" });
  const args = ["--experimental-strip-types", "scripts/evaluate-conversation.ts", "--cold"];
  if (requestedCaseIds.length) args.push(...requestedCaseIds.map((id) => `--id=${id}`));
  else if (!full) args.push("--critical-only");
  const run = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ...profileMaintenance.childEnvironment(),
      OLLAMA_MODEL: profile.id,
      OLLAMA_NUM_CTX: String(profile.recommendedContextTokens),
    },
    maxBuffer: 8 * 1024 * 1024,
  });
  process.stdout.write(run.stdout ?? "");
  process.stderr.write(run.stderr ?? "");
  spawnSync("ollama", ["stop", profile.id], { stdio: "ignore" });
  const result = /Private result:\s*(.+)\s*$/m.exec(run.stdout ?? "")?.[1]?.trim() ?? "";
  const entry: { model: string; contextTokens: number; result: string; exitCode: number; summary?: ConversationSummary; assessment?: ConversationEvaluationAssessment } = {
    model: profile.id,
    contextTokens: profile.recommendedContextTokens,
    result,
    exitCode: run.status ?? 1,
  };
  if (result) {
    entry.summary = JSON.parse(readFileSync(result, "utf8")) as ConversationSummary;
    entry.assessment = assessConversationEvaluation(entry.summary);
  }
  matrix.push(entry);
}

const outputDirectory = profileMaintenance.dataPath("evaluations", "results");
ensurePrivateDirectory(outputDirectory);
const output = resolve(outputDirectory, `model-matrix-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
profileMaintenance.assertCurrent();
writePrivateJsonFileAtomic(output, {
  schemaVersion: 1,
  suiteMode: full ? "full" : requestedCaseIds.length ? "selected" : "critical-only",
  requestedCaseIds,
  hostMemoryGb: memoryGb,
  sequential: true,
  startedAt: matrixStartedAt,
  completedAt: new Date().toISOString(),
  models: matrix,
});
console.log(`\nPrivate matrix result: ${output}`);
if (matrix.some((entry) => entry.exitCode !== 0 || !entry.summary || !entry.assessment?.passed)) process.exitCode = 1;
profileMaintenance.release();
