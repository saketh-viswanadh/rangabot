import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import {
  conversationHumanReviewAttestationStatement,
  createBlindReview,
  scoreBlindReview,
  type BlindReviewKey,
  type BlindReviewRatings,
  type ConversationEvaluationForReview,
} from "../lib/conversation-human-review.ts";
import {
  ensurePrivateDirectory,
  ensurePrivateFile,
  writePrivateJsonFileAtomic,
  writePrivateTextFileAtomic,
} from "../lib/private-storage.ts";
import { acquireProfileMaintenanceBinding } from "../lib/profile-maintenance.ts";

const command = process.argv[2];
const option = (name: string) => process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
const profileMaintenance = acquireProfileMaintenanceBinding({ label: "Conversation human review" });
const privateRoot = profileMaintenance.dataPath("evaluations");
const reviewRoot = resolve(privateRoot, "reviews");

function rejectUnknownOptions(allowed: ReadonlySet<string>) {
  const unknown = process.argv.slice(3).find((argument) => {
    if (!argument.startsWith("--")) return true;
    return !allowed.has(argument.slice(2).split("=", 1)[0]!);
  });
  if (unknown) throw new Error(`Unknown human-review argument: ${unknown}`);
}

function readPrivateArtifact<T>(path: string): { value: T; sha256: string } {
  profileMaintenance.assertCurrent();
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new Error(`Private review input does not exist: ${basename(resolved)}`);
  ensurePrivateFile(resolved, { trustedRoot: privateRoot });
  const source = readFileSync(resolved);
  return {
    value: JSON.parse(source.toString("utf8")) as T,
    sha256: createHash("sha256").update(source).digest("hex"),
  };
}

function readPrivateJson<T>(path: string): T {
  return readPrivateArtifact<T>(path).value;
}

function indented(value: string) {
  return value.split(/\r?\n/).map((line) => `    ${line}`).join("\n");
}

function packetMarkdown(packet: ReturnType<typeof createBlindReview>["packet"]) {
  const sections = packet.items.map((item) => {
    const memory = item.approvedLocalMemory.length
      ? `\nApproved local memory supplied to Rangabot:\n\n${item.approvedLocalMemory.map((entry) => indented(`[${entry.kind}] ${entry.content}`)).join("\n\n")}\n`
      : "";
    const conversation = item.conversation.map((message) => `${message.role.toUpperCase()}:\n\n${indented(message.content)}`).join("\n\n");
    return `## ${item.itemId}\n${memory}\nConversation:\n\n${conversation}\n\nRangabot answer:\n\n${indented(item.answer)}\n\nRating (1–5): ____\n\nPrivacy failure (yes/no): ____\n\nFabricated action (yes/no): ____\n\nMaterial truth failure (yes/no): ____\n\nOptional note: ____`;
  });
  return `# Blind Rangabot usefulness review\n\nPacket: ${packet.packetId}\n\nDo not open the private answer key until every rating is final.\n\n${packet.instructions.map((line) => `- ${line}`).join("\n")}\n\n## Required human attestation\n\nAfter rating every item, set all three attestation confirmations to true in the ratings JSON only if this exact statement is truthful:\n\n> ${conversationHumanReviewAttestationStatement}\n\nThis is a procedural self-attestation, not cryptographic identity proof.\n\n${sections.join("\n\n---\n\n")}\n`;
}

if (command === "prepare") {
  rejectUnknownOptions(new Set(["full", "critical"]));
  const fullPaths = process.argv.filter((argument) => argument.startsWith("--full=")).map((argument) => argument.slice(7));
  const criticalPaths = process.argv.filter((argument) => argument.startsWith("--critical=")).map((argument) => argument.slice(11));
  if (fullPaths.length !== 1 || criticalPaths.length !== 3) {
    throw new Error("Use prepare --full=<complete-result.json> --critical=<run-1.json> --critical=<run-2.json> --critical=<run-3.json> in chronological order.");
  }
  const full = readPrivateArtifact<ConversationEvaluationForReview>(fullPaths[0]!);
  const critical = criticalPaths.map((path) => readPrivateArtifact<ConversationEvaluationForReview>(path));
  const { packet, key, ratings } = createBlindReview(
    full.value,
    critical.map((artifact) => artifact.value),
    { full: full.sha256, critical: critical.map((artifact) => artifact.sha256) },
  );
  ensurePrivateDirectory(reviewRoot, { trustedRoot: privateRoot });
  const prefix = resolve(reviewRoot, `conversation-blind-${packet.packetId}`);
  profileMaintenance.assertCurrent();
  writePrivateTextFileAtomic(`${prefix}.md`, packetMarkdown(packet), { trustedRoot: privateRoot });
  writePrivateJsonFileAtomic(`${prefix}.key.json`, key, { trustedRoot: privateRoot });
  writePrivateJsonFileAtomic(`${prefix}.ratings.json`, ratings, { trustedRoot: privateRoot });
  console.log(`Blind packet: ${prefix}.md`);
  console.log(`Ratings template: ${prefix}.ratings.json`);
  console.log(`Private answer key (do not open before rating): ${prefix}.key.json`);
} else if (command === "score") {
  rejectUnknownOptions(new Set(["key", "ratings"]));
  const keyPath = option("key");
  const ratingsPath = option("ratings");
  if (!keyPath || !ratingsPath) throw new Error("Use score --key=<private-key.json> --ratings=<completed-ratings.json>.");
  const key = readPrivateJson<BlindReviewKey>(keyPath);
  const ratings = readPrivateJson<BlindReviewRatings>(ratingsPath);
  const result = scoreBlindReview(key, ratings);
  ensurePrivateDirectory(reviewRoot, { trustedRoot: privateRoot });
  const output = resolve(reviewRoot, `conversation-blind-${result.packetId}.result.json`);
  profileMaintenance.assertCurrent();
  writePrivateJsonFileAtomic(output, result, { trustedRoot: privateRoot });
  console.log(`Human usefulness: ${result.meanRating.toFixed(2)}/5 (${result.passed ? "PASS" : "FAIL"})`);
  console.log(`Private review result: ${output}`);
  if (!result.passed) process.exitCode = 1;
} else {
  throw new Error("Choose conversation human-review command: prepare or score.");
}
profileMaintenance.release();
