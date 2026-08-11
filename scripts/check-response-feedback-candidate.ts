import { requireKnownResponseFeedbackCandidate } from "../lib/response-feedback-candidate.ts";

if (process.argv.length !== 2) {
  console.error("Usage: npm run feedback:candidate:check");
  process.exit(1);
}

const candidate = requireKnownResponseFeedbackCandidate();
console.log(`Response feedback candidate verified: ${candidate.build} (${candidate.candidateBuildId}).`);
