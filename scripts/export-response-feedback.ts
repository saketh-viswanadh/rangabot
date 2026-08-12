import { existsSync, lstatSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { closeConversationDatabase, getConversationDatabase } from "../lib/conversations.ts";
import { writePrivateJsonFileAtomic } from "../lib/private-storage.ts";
import { acquireProfileMaintenanceBinding, type ProfileMaintenanceBinding } from "../lib/profile-maintenance.ts";
import { requireKnownResponseFeedbackCandidate } from "../lib/response-feedback-candidate.ts";
import { buildResponseFeedbackDailyEnvelope } from "../lib/response-feedback-export.ts";
import { aggregateResponseFeedback } from "../lib/response-feedback.ts";

function parseArguments(arguments_: string[]) {
  let day: string | undefined;
  let output: string | undefined;
  for (const argument of arguments_) {
    if (argument.startsWith("--day=")) day = argument.slice("--day=".length);
    else if (argument.startsWith("--output=")) output = argument.slice("--output=".length);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!day || !output) {
    throw new Error("Usage: npm run feedback:export -- --day=YYYY-MM-DD --output=/private/incoming/file.json");
  }
  if (!isAbsolute(output) || !output.endsWith(".json")) {
    throw new Error("The explicit feedback export path must be an absolute JSON file path.");
  }
  const destination = resolve(output);
  const root = dirname(destination);
  if (!existsSync(root) || lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) {
    throw new Error("The feedback export directory must already exist and must not be a symbolic link.");
  }
  return { day, destination, root };
}

let profileMaintenance: ProfileMaintenanceBinding | undefined;
try {
  const options = parseArguments(process.argv.slice(2));
  profileMaintenance = acquireProfileMaintenanceBinding({ label: "Response feedback export" });
  profileMaintenance.assertCurrent();
  const candidate = requireKnownResponseFeedbackCandidate();
  const counts = aggregateResponseFeedback(getConversationDatabase(), candidate.candidateBuildId, options.day);
  const envelope = buildResponseFeedbackDailyEnvelope({
    build: candidate.build,
    buildDigest: candidate.candidateBuildId,
    sourceVersion: candidate.sourceVersion,
    day: options.day,
    counts,
  });
  profileMaintenance.assertCurrent();
  writePrivateJsonFileAtomic(options.destination, envelope, { trustedRoot: options.root });
  console.log(`Private response_feedback_daily export written for ${options.day} (${candidate.build}).`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Response feedback export failed.");
  process.exitCode = 1;
} finally {
  closeConversationDatabase();
  profileMaintenance?.release();
}
