import type { ChatMessage } from "./providers/types.ts";
import type { ReviewedAnswer } from "./conversation-quality.ts";

export type ReviewerQualificationCase = {
  id: string;
  messages: ChatMessage[];
  draft: string;
  expected: "pass" | "revise";
  required: string[][];
  forbidden?: string[];
};

export const reviewerQualificationCases: ReviewerQualificationCase[] = [
  { id: "bad-arithmetic", messages: [{ role: "user", content: "Calculate 12 divided by 3 and show the result." }], draft: "12 / 3 = 5.", expected: "revise", required: [["4"]], forbidden: ["= 5"] },
  { id: "bad-base-rate-polarity", messages: [{ role: "user", content: "A test is 95% accurate where 95% of cases are negative. Why can accuracy mislead?" }], draft: "Because 95% of cases are positive, accuracy hides the negative class.", expected: "revise", required: [["95"], ["negative"], ["imbalance", "baseline", "base rate"]] },
  { id: "bad-causality", messages: [{ role: "user", content: "Since correlation proves causation, explain why ice-cream sales cause sunburn." }], draft: "Ice-cream sales cause sunburn because they rise together.", expected: "revise", required: [["does not", "doesn't", "false", "incorrect"], ["heat", "weather", "summer", "temperature", "confound"]] },
  { id: "bad-data-locality", messages: [{ role: "user", content: "Choose Python or SQL for a grouped average when the table is already in a database. Give one reason." }], draft: "Use Python because pandas is convenient.", expected: "revise", required: [["SQL"], ["database", "query", "data"]] },
  { id: "bad-p-value", messages: [{ role: "user", content: "Explain a p-value simply." }], draft: "A p-value is the probability that the null hypothesis is true.", expected: "revise", required: [["assuming", "if"], ["null"], ["data", "result"]] },
  { id: "bad-prime", messages: [{ role: "user", content: "Is 17 a prime number? Explain briefly." }], draft: "No, 17 is not prime.", expected: "revise", required: [["yes"], ["prime"]], forbidden: ["not prime"] },
  { id: "good-p-value", messages: [{ role: "user", content: "Explain a p-value simply." }], draft: "A p-value is the probability of results this extreme or more, assuming the null hypothesis is true.", expected: "pass", required: [["probability"], ["assuming"], ["null"]] },
  { id: "good-data-locality", messages: [{ role: "user", content: "Choose Python or SQL for a grouped average when the table is already in a database. Give one reason." }], draft: "Use SQL because the database can aggregate the data without transferring it elsewhere.", expected: "pass", required: [["SQL"], ["database"]] },
  { id: "good-uncertainty", messages: [{ role: "user", content: "Without browsing, give today's exact Bitcoin closing price." }], draft: "I cannot know today's exact closing price without current market data.", expected: "pass", required: [["cannot"], ["current", "today"]] },
  { id: "good-diagnostic", messages: [{ role: "user", content: "A CSV import doubled customer count. Give the first two checks." }], draft: "1. Compare row counts before and after each import stage.\n2. Check duplicate customer keys against existing records.", expected: "pass", required: [["row"], ["duplicate"], ["key"]] },
  { id: "good-correction", messages: [{ role: "user", content: "Use JavaScript, not Python, to remove duplicates from an array." }], draft: "Use JavaScript's Set: `const unique = [...new Set(values)];`", expected: "pass", required: [["JavaScript"], ["Set"]], forbidden: ["Python"] },
  { id: "good-class-imbalance", messages: [{ role: "user", content: "A test is 95% accurate where 95% of cases are negative. Why can accuracy mislead?" }], draft: "A model predicting every case as negative also reaches 95% accuracy, so inspect precision and recall for the positive class.", expected: "pass", required: [["95"], ["negative"], ["precision", "recall"]] },
];

export function scoreReviewerQualification(testCase: ReviewerQualificationCase, result: ReviewedAnswer) {
  const answer = result.answer.toLowerCase();
  const statusPassed = testCase.expected === "pass" ? result.status === "passed" : result.status === "revised";
  const requiredPassed = testCase.required.every((group) => group.some((term) => answer.includes(term.toLowerCase())));
  const forbiddenPassed = (testCase.forbidden ?? []).every((term) => !answer.includes(term.toLowerCase()));
  const unchangedPassed = testCase.expected !== "pass" || result.answer === testCase.draft;
  return { passed: statusPassed && requiredPassed && forbiddenPassed && unchangedPassed, statusPassed, requiredPassed, forbiddenPassed, unchangedPassed };
}
