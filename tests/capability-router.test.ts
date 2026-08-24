import assert from "node:assert/strict";
import test from "node:test";
import { classifyConversationalAnalysis, repositoryPreference, shouldAutoSearchKnowledge, shouldPlanWordDocument, vaultPreference } from "../lib/capability-intents.ts";
import { capabilityClarification, capabilityReceipt, planCapabilityRoute, type CapabilityRoute } from "../lib/capability-router.ts";
import { answerUnavailableAction } from "../lib/conversation-contract.ts";
import { answerDeterministicConversationRequest } from "../lib/conversation-orchestration.ts";
import type { ConversationMode } from "../lib/conversation-turns.ts";
import { classifyDirectMemoryRequest } from "../lib/memories.ts";

type Case = {
  name: string;
  request: string;
  expected: CapabilityRoute;
  mode?: ConversationMode;
  dataset?: boolean;
  code?: boolean;
};

function group(prefix: string, requests: string[], expected: CapabilityRoute, patch: Omit<Case, "name" | "request" | "expected"> = {}): Case[] {
  return requests.map((request, index) => ({ name: `${prefix}-${index + 1}`, request, expected, ...patch }));
}

function plan(entry: Omit<Case, "name" | "expected">) {
  const messages = [{ role: "user" as const, content: entry.request }];
  const mode = entry.mode ?? "local";
  const knowledgePreference = vaultPreference(entry.request);
  return planCapabilityRoute({
    messages,
    mode,
    hasDataset: Boolean(entry.dataset),
    hasCodeContext: Boolean(entry.code),
    safeContinuationAvailable: Boolean(answerUnavailableAction(entry.request)),
    deterministicAvailable: Boolean(answerDeterministicConversationRequest(messages)),
    directMemoryAvailable: Boolean(classifyDirectMemoryRequest(entry.request)),
    wordRequested: shouldPlanWordDocument(messages),
    analysisIntent: classifyConversationalAnalysis(messages),
    vaultRequested: knowledgePreference === "use" || mode === "teach" || mode === "smart" && shouldAutoSearchKnowledge(entry.request),
    vaultPreference: knowledgePreference,
    repositoryPreference: repositoryPreference(entry.request),
  });
}

const cases: Case[] = [
  ...group("conversation", ["Hello", "Help me think through a decision", "Explain empathy", "What should I cook?", "Brainstorm names", "Tell me a joke"], "conversation"),
  { name: "unrelated-code-attachment-does-not-hijack", request: "Tell me a joke about dogs.", expected: "conversation", code: true },
  ...group("deterministic", ["Reply with exactly one word: ready.", "Reply with exactly one word: yes.", "Reply with exactly one word: local.", "Reply with exactly one word: private."], "deterministic-answer"),
  ...group("deterministic-arithmetic", ["Calculate 10% of 250", "What is 24 - (8 × 2)?"], "deterministic-answer"),
  ...group("safe", ["Send an email to Priya saying the meeting is cancelled.", "Forward this message to Alex.", "Delete tomorrow's calendar meeting.", "Browse the web and confirm today's headline.", "Transfer $50 to Alex."], "safe-continuation"),
  ...group("memory", ["What is my name?", "What's my name?", "Do you remember my name?", "What do you remember about me?", "Show me my saved memories."], "direct-memory"),
  ...group("analytics", ["Count the attached rows", "Average revenue in this dataset", "Show the top five records", "Compare columns in the selected data", "Find the trend in this CSV", "List unmatched rows", "Calculate the rate from this table"], "analytics", { dataset: true }),
  ...group("missing-data", ["Count the attached rows", "Compare columns in the selected data", "Summarize this CSV", "Filter the uploaded dataset"], "clarification"),
  ...group("word", ["Create a Word report", "Make a DOCX", "Prepare a Word brief", "Export this as a document", "Write a Word proposal", "Create meeting notes in Word"], "word-document"),
  ...group("vault", ["What do my local books say?", "Compare my Knowledge Vault sources", "Explain from my local documents", "What can the vault teach me?", "Explain SQL joins?", "Teach me about mythology"], "knowledge-vault", { mode: "smart" }),
  ...group("repository", ["Explain this function", "Review this code excerpt", "What does this class do?", "Find the bug in this code", "Suggest a refactor for this script"], "repository-context", { code: true }),
  { name: "clarify-analysis-word", request: "Analyze the attached data and create a Word report", expected: "clarification", dataset: true },
  { name: "clarify-analysis-vault", request: "Analyze this dataset using my Knowledge Vault", expected: "clarification", dataset: true },
  { name: "clarify-word-vault", request: "Create a Word document from my Knowledge Vault", expected: "clarification" },
  { name: "clarify-analysis-code", request: "Compare this code with the attached data", expected: "clarification", dataset: true, code: true },
  { name: "clarify-triple", request: "Analyze this dataset, use my Knowledge Vault, and create a Word report", expected: "clarification", dataset: true },
  { name: "clarify-analysis-word-code", request: "Analyze the attached data and create a Word report explaining this code", expected: "clarification", dataset: true, code: true },
  { name: "choice-ignore-code", request: "Count rows in the attached dataset; ignore the code excerpt.", expected: "analytics", dataset: true, code: true },
  { name: "choice-ignore-data", request: "Explain this code; do not analyze the attached dataset.", expected: "repository-context", dataset: true, code: true },
  { name: "choice-teach-ignore-vault", request: "Create a Word document; do not use my Knowledge Vault.", expected: "word-document", mode: "teach" },
  { name: "choice-smart-ignore-vault", request: "Write a Word brief without my local books.", expected: "word-document", mode: "smart" },
  { name: "choice-smart-word", request: "Create a Word document explaining SQL.", expected: "word-document", mode: "smart" },
  { name: "choice-incidental-code", request: "Count the attached rows.", expected: "analytics", dataset: true, code: true },
  ...group("educational-data-terms", ["Explain CSV format", "Explain the database schema", "Explain dataset bias", "Compare CSV and Parquet formats", "Explain columns and rows to a beginner"], "conversation"),
  ...group("attached-data-does-not-hijack", ["Explain what an average is.", "What does trend mean?", "How can I increase my confidence?", "Tell me a joke about statistics."], "conversation", { dataset: true }),
  ...group("conceptual-data-does-not-hijack", ["List database normalization rules", "Show table design best practices", "Analyze data privacy ethics", "Summarize dataset documentation", "Inspect CSV parsing code", "List common data types", "Show examples of table joins", "Filter data in JavaScript"], "conversation", { dataset: true }),
  ...group("natural-attached-analysis", ["What was average revenue last month?", "Which product had highest sales?", "How many customers churned?", "Why did revenue decline?", "Plot monthly sales?"], "analytics", { dataset: true }),
  ...group("deictic-attached-analysis", ["Show me its schema", "What columns does it have?", "Summarize it", "Filter it to active rows"], "analytics", { dataset: true }),
  ...group("ordinary-code-attachment-opt-out", ["Ignore the attachment and answer generally.", "Answer without the attachment.", "Do not use that attachment.", "Skip the attached excerpt."], "conversation", { code: true }),
  { name: "latest-negative-data", request: "Analyze the attached data; actually do not use it.", expected: "conversation", dataset: true },
  { name: "latest-negative-code", request: "Use this code; actually do not use it.", expected: "conversation", code: true },
  { name: "latest-negative-vault", request: "Use the Vault; actually do not.", expected: "conversation", mode: "smart" },
  { name: "latest-negative-word", request: "Create a Word report; actually do not.", expected: "conversation" },
  { name: "latest-positive-data", request: "Do not analyze the old data; analyze this attached dataset instead.", expected: "analytics", dataset: true },
  { name: "latest-positive-code", request: "Ignore the old code; use this code excerpt instead.", expected: "repository-context", code: true },
  { name: "latest-positive-vault", request: "Ignore the Vault for background; use the Vault for citations.", expected: "knowledge-vault", mode: "smart" },
  { name: "latest-positive-word", request: "Do not use the old Word document; create a new Word report instead.", expected: "word-document" },
  { name: "mixed-use-data-ignore-code", request: "Analyze the attached data and do not use the code excerpt.", expected: "analytics", dataset: true, code: true },
  { name: "mixed-use-code-ignore-data", request: "Review this code and ignore the attached data.", expected: "repository-context", dataset: true, code: true },
  { name: "mixed-use-word-ignore-vault", request: "Create a Word report without the Vault.", expected: "word-document", mode: "smart" },
  { name: "mixed-use-vault-ignore-attachment", request: "Use the Vault without the attachment.", expected: "knowledge-vault", mode: "smart", dataset: true, code: true },
  { name: "instead-use-code", request: "Use this code instead of the attached data.", expected: "repository-context", dataset: true, code: true },
  { name: "rather-use-data", request: "Analyze the attached data rather than the code excerpt.", expected: "analytics", dataset: true, code: true },
  { name: "instead-use-vault", request: "Use the Vault instead of the attachment.", expected: "knowledge-vault", mode: "smart", dataset: true, code: true },
  { name: "instead-answer-in-chat", request: "Answer in chat instead of creating a Word document.", expected: "conversation" },
  { name: "generic-latest-positive-data", request: "Ignore the attached data; actually analyze it.", expected: "analytics", dataset: true },
  { name: "generic-latest-positive-code", request: "Ignore this code; actually review it.", expected: "repository-context", code: true },
  { name: "generic-latest-positive-vault", request: "Ignore the Vault; actually search it.", expected: "knowledge-vault", mode: "smart" },
  { name: "generic-latest-positive-word", request: "Do not create a Word document; actually make it.", expected: "word-document" },
  ...group("adjacent-conceptual-data", ["Query database tutorial", "List rows and columns terminology", "List table constraints in SQL", "Summarize data retention policy"], "conversation", { dataset: true }),
  ...group("analyst-shorthand", ["Average revenue", "Count rows", "Top customers", "Revenue by region", "Sales by month", "What columns are there?"], "analytics", { dataset: true }),
  ...group("natural-bi-variants", ["Compare revenue by region", "Break down revenue by region", "Rank products by sales", "Find duplicate customers", "What caused conversion to drop?", "What is our most valuable product?", "Calculate conversion rate by channel", "Forecast next month sales", "Group customers by segment", "Show sales trends by month", "Median order value", "Bottom 10 products", "Customers by status"], "analytics", { dataset: true }),
  ...group("unrelated-data-does-not-hijack", ["How many hours should I sleep?", "How many words should an email have?", "Which option is the best?", "What is the average human lifespan?", "How many days should a vacation last?", "Which approach is best for learning?", "What is the mean body temperature?", "Explain how rates work in general", "How many planets exist?", "How many people live in India?", "What was the average temperature on Earth?"], "conversation", { dataset: true }),
  ...group("unbound-nominal-data-does-not-hijack", ["Top vacation destinations", "Average blood pressure", "Books by Tolkien", "Planets by size", "Top films"], "conversation", { dataset: true }),
  ...group("explicitly-bound-nominal-data", ["Top vacation destinations in this dataset", "Average blood pressure in this dataset", "Books by Tolkien in this CSV", "Planets by size in this dataset", "Top films in this dataset"], "analytics", { dataset: true }),
  ...group("unbound-general-analysis-does-not-hijack", ["Compare phones by battery life", "Rank planets by size", "Forecast the weather", "Plot a route to Delhi", "Plot planets by size", "Chart constellations", "Visualize the solar system", "Plot election results", "Group these ideas by theme", "Show me top restaurants", "Compare red and blue by aesthetics", "Break down this argument by premise"], "conversation", { dataset: true }),
  ...group("explicitly-bound-general-analysis", ["Compare phones by battery life in this dataset", "Rank planets by size in this dataset", "Forecast the weather from this dataset", "Plot a route to Delhi from this dataset", "Group these ideas by theme in this dataset", "Show me top restaurants in this dataset", "Compare red and blue by aesthetics in this dataset", "Break down this argument by premise in this dataset"], "analytics", { dataset: true }),
  { name: "generic-no-data", request: "Analyze the attached data; actually, no.", expected: "conversation", dataset: true },
  { name: "generic-no-code", request: "Review this code; actually, no.", expected: "conversation", code: true },
  { name: "generic-no-vault", request: "Use the Vault; actually, no.", expected: "conversation", mode: "smart" },
  { name: "generic-no-word", request: "Create a Word report; actually, no.", expected: "conversation" },
  { name: "generic-dont-do-that-data", request: "Analyze the attached data; don’t do that.", expected: "conversation", dataset: true },
  { name: "generic-dont-do-that-word", request: "Create a Word report; don’t do that.", expected: "conversation" },
  { name: "generic-forget-it-code", request: "Review this code; forget it.", expected: "conversation", code: true },
  { name: "generic-please-dont-vault", request: "Use the Vault; please don’t.", expected: "conversation", mode: "smart" },
  { name: "generic-no-cancels-immediately-prior-only", request: "Analyze the attached data; create a Word report; actually, no.", expected: "analytics", dataset: true },
  ...group("natural-analysis-needs-data", ["What was average revenue last month?", "Average revenue", "Revenue by region"], "clarification"),
  ...group("word-advice-stays-conversation", ["Should I create a Word document?", "What is the best way to create a Word report?", "Give me steps to export a DOCX"], "conversation"),
  { name: "word-explicit-action-not-advice", request: "Please create a Word report", expected: "word-document" },
  ...group("deictic-code-use", ["What does this do?", "Review it", "Find the bug in this"], "repository-context", { code: true }),
  { name: "decline-word", request: "Do not make a DOCX. Answer in chat.", expected: "conversation" },
  { name: "decline-word-use-data", request: "Analyze the attached data; do not create a Word document.", expected: "analytics", dataset: true },
  { name: "decline-word-use-vault", request: "Do not create a Word document; answer from my Knowledge Vault.", expected: "knowledge-vault" },
  { name: "decline-web", request: "Do not browse the web; explain what web browsing is.", expected: "conversation" },
  { name: "instructional-web-in-word", request: "Create a Word guide explaining how to browse the web privately.", expected: "word-document" },
  { name: "decline-attached-file", request: "Do not use the attached file; answer generally.", expected: "conversation", dataset: true },
  { name: "decline-attached-code-file", request: "Do not use the attached file; answer generally.", expected: "conversation", code: true },
  { name: "decline-export-docx", request: "Do not export it to DOCX; answer in chat.", expected: "conversation" },
  { name: "instructional-word", request: "How do I create a Word document?", expected: "conversation" },
  { name: "decline-word-followup", request: "Answer in chat, not a document.", expected: "conversation" },
  { name: "skip-word-followup", request: "Actually, skip the Word document and answer here.", expected: "conversation" },
  { name: "decline-vault-without", request: "Answer without the Vault", expected: "conversation", mode: "smart" },
  { name: "decline-vault-ignore", request: "Ignore the Vault", expected: "conversation", mode: "teach" },
  { name: "decline-vault-skip", request: "Skip the vault", expected: "conversation", mode: "smart" },
  ...group("explicit-local-vault", ["Use the Vault to answer this", "Search the vault for this topic", "Answer from Vault"], "knowledge-vault"),
  ...group("unavailable", ["Use Codex", "Send this to the cloud", "Use cloud mode", "Hand this off externally"], "unavailable", { mode: "codex" }),
];

test("217 real prompt-to-route cases select one bounded capability without opening resources", () => {
  assert.equal(cases.length, 217);
  for (const entry of cases) {
    const result = plan(entry);
    assert.equal(result.route, entry.expected, entry.name);
    assert.equal(result.version, "capability-route-v1", entry.name);
    assert.equal(result.reasons.length > 0, true, entry.name);
  }
});

test("clarification reports requirements internally but receipts claim no resource access", () => {
  const result = plan({ request: "Analyze the attached data and create a Word report", dataset: true });
  assert.equal(result.status, "clarify");
  assert.deepEqual(result.requiredContexts, ["dataset"]);
  assert.deepEqual(capabilityReceipt(result).contexts, []);
  assert.match(capabilityClarification(result) ?? "", /No attached resource has been opened yet/i);
});

test("missing required data asks for an attachment rather than improvising", () => {
  const result = plan({ request: "Count the attached rows" });
  assert.equal(result.route, "clarification");
  assert.deepEqual(result.reasons, ["missing-required-dataset"]);
  assert.match(capabilityClarification(result) ?? "", /don't have an approved dataset attached/i);
});

test("drafting stays local while explicit execution becomes a useful safe continuation", () => {
  assert.equal(plan({ request: "Draft an email to Priya about the delay." }).route, "conversation");
  assert.equal(plan({ request: "Explain how to write an email to Priya." }).route, "conversation");
  assert.equal(plan({ request: "I cannot send it; draft an email to Priya." }).route, "conversation");
  const continuation = answerUnavailableAction("Send an email to Priya saying the meeting is cancelled.");
  assert.equal(plan({ request: "Send an email to Priya saying the meeting is cancelled." }).route, "safe-continuation");
  assert.match(continuation?.answer ?? "", /Nothing was sent/);
  assert.match(continuation?.answer ?? "", /Hi Priya/);
  assert.match(continuation?.answer ?? "", /meeting is cancelled/i);
  for (const request of ["Please email Priya saying hello.", "Can you email Priya saying hello?", "Could you message Priya saying hello?"]) {
    assert.equal(plan({ request }).route, "safe-continuation", request);
  }
  for (const request of ["Email security is important. Explain why.", "Message queues improve reliability. Explain how."]) {
    assert.equal(plan({ request }).route, "conversation", request);
  }
});

test("current request can end a pending Word workflow", () => {
  const pending = [
    { role: "user" as const, content: "Create a Word report" },
    { role: "assistant" as const, content: "Who is the audience?", artifactIntent: "word" as const },
  ];
  for (const content of [
    "Actually, skip the Word document and answer here.",
    "No document, just answer here.",
    "Keep this in chat.",
    "Chat only, please.",
    "Cancel that and answer normally.",
    "I changed my mind; answer here.",
    "Actually, no.",
    "No.",
    "No thanks.",
    "Don’t do that.",
    "Forget it.",
    "Please don’t.",
  ]) {
    assert.equal(shouldPlanWordDocument([...pending, { role: "user" as const, content }]), false, content);
  }
  assert.equal(shouldPlanWordDocument([...pending, { role: "user" as const, content: "The audience is executives." }]), true);
  assert.equal(shouldPlanWordDocument([...pending, { role: "user" as const, content: "Do not make it; actually create it for executives." }]), true);
});

test("code intent requires current-turn authority rather than unrelated coding advice", () => {
  for (const content of [
    "How should I review code?",
    "What are code review best practices?",
    "Explain how functions work in general.",
    "Explain this concept.",
    "Find the bug in this reasoning.",
  ]) {
    assert.equal(repositoryPreference(content), "unspecified", content);
  }
  for (const content of ["What does this do?", "Review it", "Find the bug in this", "Review this code excerpt"]) {
    assert.equal(repositoryPreference(content), "use", content);
  }
  for (const content of ["Ignore the attachment", "Do not review this code", "Skip the attached excerpt"]) {
    assert.equal(repositoryPreference(content), "ignore", content);
  }
});
