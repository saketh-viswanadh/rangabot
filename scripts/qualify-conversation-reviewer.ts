import { resolve } from "node:path";
import { compileAnswerContract } from "../lib/conversation-contract.ts";
import { reviewConversationAnswer } from "../lib/conversation-quality.ts";
import { reviewerQualificationCases, scoreReviewerQualification } from "../lib/reviewer-qualification.ts";
import { completeJsonWithOllama } from "../lib/providers/ollama.ts";
import { getConfiguredChatModel } from "../lib/local-runtime-config.ts";
import { ensurePrivateDirectory, writePrivateJsonFileAtomic } from "../lib/private-storage.ts";
import { acquireProfileMaintenanceBinding } from "../lib/profile-maintenance.ts";

const profileMaintenance = acquireProfileMaintenanceBinding({ label: "Conversation reviewer qualification" });

const results = [];
console.log(`Qualifying ${getConfiguredChatModel()} as a local answer reviewer with ${reviewerQualificationCases.length} frozen good/bad cases.`);
for (const [index, testCase] of reviewerQualificationCases.entries()) {
  const started = Date.now();
  const contract = compileAnswerContract(testCase.messages);
  const reviewed = await reviewConversationAnswer({ messages: testCase.messages, contractMessages: testCase.messages, contract, draft: testCase.draft, completeJson: completeJsonWithOllama, force: true });
  const score = scoreReviewerQualification(testCase, reviewed);
  results.push({ id: testCase.id, expected: testCase.expected, reviewStatus: reviewed.status, latencyMs: Date.now() - started, ...score });
  console.log(`${score.passed ? "PASS" : "FAIL"} ${index + 1}/${reviewerQualificationCases.length} ${testCase.id} (${reviewed.status}, ${Date.now() - started}ms)`);
}
const passed = results.filter((result) => result.passed).length;
const qualification = { version: "1.0.0", model: getConfiguredChatModel(), passed, total: results.length, qualified: passed === results.length, results, completedAt: new Date().toISOString() };
const directory = profileMaintenance.dataPath("evaluations", "results");
ensurePrivateDirectory(directory);
const output = resolve(directory, `reviewer-qualification-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
profileMaintenance.assertCurrent();
writePrivateJsonFileAtomic(output, qualification);
console.log(`\nReviewer qualification: ${qualification.qualified ? "PASS" : "FAIL"} (${passed}/${results.length})`);
console.log(`Private result: ${output}`);
if (!qualification.qualified) process.exitCode = 1;
profileMaintenance.release();
