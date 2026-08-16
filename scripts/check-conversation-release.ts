import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { evaluateConversationReleaseGate } from "../lib/conversation-release-gate.ts";
import { ensurePrivateFile } from "../lib/private-storage.ts";
import { acquireProfileMaintenanceBinding } from "../lib/profile-maintenance.ts";

const profileMaintenance = acquireProfileMaintenanceBinding({ label: "Conversation release evidence check" });
const privateRoot = profileMaintenance.dataPath("evaluations");

function valuesFor(name: string) {
  return process.argv.slice(2).filter((argument) => argument.startsWith(`--${name}=`)).map((argument) => argument.slice(name.length + 3));
}

function readPrivateArtifact(path: string): { value: unknown; sha256: string } {
  profileMaintenance.assertCurrent();
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new Error(`Private release-gate input does not exist: ${basename(resolved)}`);
  ensurePrivateFile(resolved, { trustedRoot: privateRoot });
  const source = readFileSync(resolved);
  return {
    value: JSON.parse(source.toString("utf8")) as unknown,
    sha256: createHash("sha256").update(source).digest("hex"),
  };
}

function git(args: string[]) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

try {
  const allowed = new Set(["full", "critical", "human"]);
  const unknown = process.argv.slice(2).filter((argument) => !argument.startsWith("--") || !allowed.has(argument.slice(2).split("=", 1)[0]!));
  if (unknown.length) throw new Error(`Unknown release-gate argument: ${unknown[0]}`);
  const fullPaths = valuesFor("full");
  const criticalPaths = valuesFor("critical");
  const humanPaths = valuesFor("human");
  if (fullPaths.length !== 1 || humanPaths.length !== 1 || criticalPaths.length !== 3) {
    throw new Error("Use --full=<result.json> --critical=<run-1.json> --critical=<run-2.json> --critical=<run-3.json> --human=<scored-review.json>.");
  }
  const resolvedCriticalPaths = criticalPaths.map((path) => resolve(path));
  const full = readPrivateArtifact(fullPaths[0]!);
  const critical = criticalPaths.map(readPrivateArtifact);
  const human = readPrivateArtifact(humanPaths[0]!);
  const decision = evaluateConversationReleaseGate({
    currentGit: {
      commit: git(["rev-parse", "HEAD"]),
      dirty: Boolean(git(["status", "--porcelain"])),
    },
    full: full.value,
    criticalRuns: critical.map((artifact) => artifact.value),
    humanReview: human.value,
    criticalSourceIds: resolvedCriticalPaths,
    sourceDigests: {
      full: full.sha256,
      critical: critical.map((artifact) => artifact.sha256),
      human: human.sha256,
    },
  });
  if (!decision.passed) {
    console.error("Conversation release gate: FAIL");
    for (const failure of decision.failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else {
    console.log("Conversation release gate: PASS");
    console.log(`Candidate: ${decision.evidence.commit}`);
    console.log(`Model/context: ${decision.evidence.model} / ${decision.evidence.contextTokens}`);
    console.log(`Model digest/quantization: ${decision.evidence.modelDigest} / ${decision.evidence.modelQuantization}`);
    console.log(`Full suite: ${decision.evidence.full.passed}/${decision.evidence.full.total}; critical ${decision.evidence.full.criticalPassed}/${decision.evidence.full.criticalTotal}`);
    console.log(`Repeated critical runs: ${decision.evidence.repeatedCriticalRuns}/3`);
    console.log(`Human usefulness: ${decision.evidence.humanMeanRating?.toFixed(2)}/5`);
  }
} catch (error) {
  console.error(`Conversation release gate: FAIL\n- ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
profileMaintenance.release();
