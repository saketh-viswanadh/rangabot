import assert from "node:assert/strict";
import test from "node:test";
import { compileAnswerContract } from "../lib/conversation-contract.ts";
import { auditFinishedAnswer, deriveFinishVerificationPlan, type FinishVerificationIssue } from "../lib/finish-verification.ts";
import type { ChatMessage } from "../lib/providers/types.ts";

type Case = { request: string; good: string; bad: string; issue: FinishVerificationIssue["code"] };

const cases: Case[] = [
  { request: "Calculate 36 / 4?", good: "The result is 9.", bad: "The result is 8.", issue: "arithmetic" },
  { request: "Compute 17 plus 28?", good: "The answer is 45.", bad: "The answer is 44.", issue: "arithmetic" },
  { request: "Work out 7 times 8?", good: "The answer is 56.", bad: "The answer is 54.", issue: "arithmetic" },
  { request: "What is (20 - 8) / 3?", good: "The result is 4.", bad: "The result is 6.", issue: "arithmetic" },
  { request: "Calculate 2.5 multiplied by 4?", good: "The result is 10.", bad: "The result is 8.", issue: "arithmetic" },

  { request: "Write exactly three numbered checks for a backup.", good: "1. Create it\n2. Verify it\n3. Restore it", bad: "1. Create it\n2. Verify it", issue: "list-count" },
  { request: "Write exactly two bullet points about sleep.", good: "- Keep a routine\n- Limit late caffeine", bad: "- Keep a routine", issue: "list-count" },
  { request: "Write exactly five words about careful testing.", good: "Careful tests prevent costly regressions.", bad: "Careful tests prevent regressions.", issue: "word-count" },
  { request: "Write exactly two sentences welcoming a new teammate.", good: "Welcome to the team. We are glad you joined.", bad: "Welcome to the team.", issue: "sentence-count" },
  { request: "Write a short update with no bullets.", good: "The rollout is complete and monitoring is healthy.", bad: "- Rollout complete\n- Monitoring healthy", issue: "format" },

  { request: "Rewrite the note and preserve \"ticket RB-204\" exactly.", good: "The update concerns ticket RB-204.", bad: "The update concerns the support ticket.", issue: "preservation" },
  { request: "Edit this message but keep \"Friday at 3 PM\" exactly.", good: "Let us meet Friday at 3 PM.", bad: "Let us meet Friday afternoon.", issue: "preservation" },
  { request: "Revise the warning and retain \"do not restart\" exactly.", good: "Important: do not restart until approval.", bad: "Important: wait for approval.", issue: "preservation" },
  { request: "Rewrite this and leave \"ACME-17\" unchanged.", good: "Reference ACME-17 in the report.", bad: "Reference the account in the report.", issue: "preservation" },
  { request: "Edit the reply and preserve \"₹1,250\" exactly.", good: "The approved total is ₹1,250.", bad: "The approved total is 1,250 rupees.", issue: "preservation" },

  { request: "Write a concise launch announcement.", good: "RangaBot launches today with private, local assistance.", bad: "RangaBot launches today...", issue: "incomplete" },
  { request: "Draft a short release note.", good: "This release improves response reliability.", bad: "Release note:", issue: "incomplete" },
  { request: "Write a short status update.", good: "The migration finished and validation passed.", bad: "The migration is TODO", issue: "incomplete" },
  { request: "Draft a complete reply to the customer.", good: "Thanks for reporting this. We fixed the issue and verified the result.", bad: "Thanks for reporting this [continued]", issue: "incomplete" },
  { request: "Write a Markdown explanation with one code example.", good: "Use this example:\n```text\ncomplete\n```", bad: "Use this example:\n```text\nincomplete", issue: "incomplete" },

  { request: "Write JavaScript code for a square function.", good: "```javascript\nfunction square(n) { return n * n; }\n```", bad: "A square function multiplies a number by itself.", issue: "missing-code" },
  { request: "Create a Python function that greets a name.", good: "```python\ndef greet(name):\n    return f\"Hello, {name}\"\n```", bad: "```python\n  \n```", issue: "code-structure" },
  { request: "Implement a TypeScript class for a counter.", good: "```typescript\nclass Counter { value = 0; increment() { this.value += 1; } }\n```", bad: "```typescript\nclass Counter { value = 0;", issue: "incomplete" },
  { request: "Write Java code that prints hello.", good: "```java\nclass Main { public static void main(String[] args) { System.out.println(\"hello\"); } }\n```", bad: "```java\n\n```", issue: "code-structure" },
  { request: "Create a JavaScript script that logs a message.", good: "```javascript\nconsole.log(\"ready\");\n```", bad: "A script should log ready.", issue: "missing-code" },
];

function audit(request: string, answer: string) {
  const messages: ChatMessage[] = [{ role: "user", content: request }];
  const contract = compileAnswerContract(messages);
  return auditFinishedAnswer(answer, deriveFinishVerificationPlan(contract), contract);
}

test("50-case cross-task regression corpus separates complete and defective answers", () => {
  let cleanAccepted = 0;
  let defectsDetected = 0;
  for (const entry of cases) {
    const goodIssues = audit(entry.request, entry.good);
    const badIssues = audit(entry.request, entry.bad);
    if (!goodIssues.length) cleanAccepted += 1;
    if (badIssues.some((issue) => issue.code === entry.issue)) defectsDetected += 1;
  }
  assert.equal(cases.length * 2, 50);
  assert.equal(cleanAccepted, cases.length);
  assert.equal(defectsDetected, cases.length);
});
