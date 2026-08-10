import { existsSync, readFileSync } from "node:fs";
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

const command = process.argv[2];
const option = (name: string) => process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
const privateRoot = resolve("data/evaluations");
const reviewRoot = resolve(privateRoot, "reviews");

function readPrivateJson<T>(path: string): T {
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new Error(`Private review input does not exist: ${basename(resolved)}`);
  ensurePrivateFile(resolved, { trustedRoot: privateRoot });
  return JSON.parse(readFileSync(resolved, "utf8")) as T;
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
  const resultPath = option("result");
  if (!resultPath) throw new Error("Use prepare --result=<complete-private-conversation-result.json>.");
  const summary = readPrivateJson<ConversationEvaluationForReview>(resultPath);
  const { packet, key, ratings } = createBlindReview(summary);
  ensurePrivateDirectory(reviewRoot, { trustedRoot: privateRoot });
  const prefix = resolve(reviewRoot, `conversation-blind-${packet.packetId}`);
  writePrivateTextFileAtomic(`${prefix}.md`, packetMarkdown(packet), { trustedRoot: privateRoot });
  writePrivateJsonFileAtomic(`${prefix}.key.json`, key, { trustedRoot: privateRoot });
  writePrivateJsonFileAtomic(`${prefix}.ratings.json`, ratings, { trustedRoot: privateRoot });
  console.log(`Blind packet: ${prefix}.md`);
  console.log(`Ratings template: ${prefix}.ratings.json`);
  console.log(`Private answer key (do not open before rating): ${prefix}.key.json`);
} else if (command === "score") {
  const keyPath = option("key");
  const ratingsPath = option("ratings");
  if (!keyPath || !ratingsPath) throw new Error("Use score --key=<private-key.json> --ratings=<completed-ratings.json>.");
  const key = readPrivateJson<BlindReviewKey>(keyPath);
  const ratings = readPrivateJson<BlindReviewRatings>(ratingsPath);
  const result = scoreBlindReview(key, ratings);
  ensurePrivateDirectory(reviewRoot, { trustedRoot: privateRoot });
  const output = resolve(reviewRoot, `conversation-blind-${result.packetId}.result.json`);
  writePrivateJsonFileAtomic(output, result, { trustedRoot: privateRoot });
  console.log(`Human usefulness: ${result.meanRating.toFixed(2)}/5 (${result.passed ? "PASS" : "FAIL"})`);
  console.log(`Private review result: ${output}`);
  if (!result.passed) process.exitCode = 1;
} else {
  throw new Error("Choose conversation human-review command: prepare or score.");
}
