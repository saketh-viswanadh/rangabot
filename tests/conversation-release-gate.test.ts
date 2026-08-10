import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  conversationHumanReviewAttestationStatement,
  createBlindReview,
  scoreBlindReview,
  type BlindReviewRatings,
  type ConversationEvaluationForReview,
} from "../lib/conversation-human-review.ts";
import {
  conversationReleaseGatePolicy,
  evaluateConversationReleaseGate,
  type ConversationReleaseGateInput,
} from "../lib/conversation-release-gate.ts";
import {
  conversationEvaluationCases,
  getConversationEvaluationSuiteDigest,
  scoreConversationEvaluationAnswer,
  type ConversationEvaluationRule,
} from "../lib/conversation-evaluation-suite.ts";

const commit = "a".repeat(40);
const sourceDigest = (value: string) => createHash("sha256").update(value).digest("hex");
const modelDigest = "b".repeat(64);
const modelDetails = { family: "llama", parameter_size: "3B", quantization_level: "Q4_K_M" };
const host = {
  hostname: "synthetic-host",
  platform: "darwin",
  release: "25.6.0",
  architecture: "arm64",
  cpu: "Synthetic CPU",
  logicalCpuCount: 8,
  totalMemoryBytes: 17_179_869_184,
  node: "v24.18.0",
};
const capabilities = [
  "direct-usefulness", "format-adherence", "continuity", "correction-precedence",
  "honest-uncertainty", "reasoning", "adaptation", "memory-use", "memory-privacy",
  "memory-precedence", "unavailable-actions", "scope-judgment",
] as const;

function passingAnswer(rule: ConversationEvaluationRule) {
  if (rule.matches?.some((pattern) => pattern === "^YES$")) return "YES";
  if (rule.matches?.some((pattern) => pattern.includes("[a-z]+,[a-z]+"))) return "safe,clear,tested,stable";
  const terms = [...(rule.all ?? []), ...(rule.allAny ?? []).map((group) => group[0]!), ...(rule.any?.slice(0, 1) ?? [])];
  const content = terms.join(" ") || "useful answer";
  if (rule.numberedItems) return Array.from({ length: rule.numberedItems }, (_, index) => `${index + 1}. ${index ? "check" : content}`).join("\n");
  if (rule.bulletItems) return Array.from({ length: rule.bulletItems }, (_, index) => `- ${index ? "detail" : content}`).join("\n");
  if (rule.outlineItems) return Array.from({ length: rule.outlineItems }, (_, index) => `${index + 1}. ${index ? "section" : content}`).join("\n");
  return content;
}

function resultRows() {
  return conversationEvaluationCases.map((testCase) => {
    const answer = passingAnswer(testCase.rule);
    assert.equal(scoreConversationEvaluationAnswer(answer, testCase.rule).passed, true, `Fixture answer must pass ${testCase.id}`);
    return {
      id: testCase.id,
      category: testCase.category,
      critical: Boolean(testCase.critical),
      input: structuredClone({ messages: testCase.messages, memories: testCase.memories ?? [], rule: testCase.rule }),
      answer,
      latencyMs: 1_000,
      passed: true,
    };
  });
}

function summary(rows = resultRows(), criticalOnly = false, run = 0) {
  const selected = (criticalOnly ? rows.filter((row) => row.critical) : rows).map((row) => ({ ...row }));
  const passed = selected.filter((row) => row.passed).length;
  const critical = selected.filter((row) => row.critical);
  const byCapability = Object.fromEntries(capabilities.map((category) => {
    const categoryRows = selected.filter((row) => row.category === category);
    const categoryPassed = categoryRows.filter((row) => row.passed).length;
    return [category, { passed: categoryPassed, total: categoryRows.length, passRate: categoryRows.length ? categoryPassed / categoryRows.length : null }];
  }));
  return {
    suite: { name: "rangabot-core-conversation", schemaVersion: 1, version: conversationReleaseGatePolicy.suiteVersion, digest: getConversationEvaluationSuiteDigest() },
    mode: "candidate",
    startedAt: `2026-08-10T0${run}:00:00.000Z`,
    completedAt: `2026-08-10T0${run}:10:00.000Z`,
    runtime: {
      git: { commit, dirty: false },
      model: { name: "synthetic:3b", configuredContext: "4096", digest: modelDigest, details: modelDetails, contextLength: 131_072 },
      ollama: { version: "0.11.4" },
      host: { ...host },
      runState: "cold-declared",
    },
    selection: { completeSuite: !criticalOnly, criticalOnly, requestedIds: [] },
    totals: { passed, total: selected.length, passRate: passed / selected.length, completed: selected.length, completionRate: 1, errors: 0 },
    critical: { passed: critical.filter((row) => row.passed).length, total: critical.length, passRate: critical.length ? critical.filter((row) => row.passed).length / critical.length : null },
    byCapability,
    averageLatencyMs: 1_000,
    results: selected,
  };
}

function human(full: ReturnType<typeof summary>) {
  const { key, ratings } = createBlindReview(full as unknown as ConversationEvaluationForReview);
  const completed: BlindReviewRatings = {
    ...ratings,
    reviewer: "Synthetic human fixture",
    reviewedAt: "2026-08-10T10:00:00.000Z",
    attestation: {
      humanReviewer: true,
      completedWithoutAutomatedAssistance: true,
      ratingsFinalizedBeforeKey: true,
      statement: conversationHumanReviewAttestationStatement,
    },
    items: ratings.items.map((item) => ({ ...item, rating: 4 })),
  };
  return scoreBlindReview(key, completed);
}

function fixture(): ConversationReleaseGateInput {
  const rows = resultRows();
  const full = summary(rows, false, 1);
  return {
    currentGit: { commit, dirty: false },
    full,
    criticalRuns: [summary(rows, true, 2), summary(rows, true, 3), summary(rows, true, 4)],
    humanReview: human(full),
    criticalSourceIds: ["run-1", "run-2", "run-3"],
    sourceDigests: {
      full: sourceDigest("full"),
      critical: [sourceDigest("critical-1"), sourceDigest("critical-2"), sourceDigest("critical-3")],
      human: sourceDigest("human"),
    },
  };
}

test("passes only a complete frozen candidate with repeated critical and human evidence", () => {
  const decision = evaluateConversationReleaseGate(fixture());
  assert.equal(decision.passed, true, decision.failures.join("\n"));
  assert.deepEqual(decision.evidence.full, { passed: 60, total: 60, criticalPassed: 22, criticalTotal: 22 });
});

test("accepts a valid SHA-256 Git object-format candidate", () => {
  const input = fixture();
  const sha256Commit = "d".repeat(64);
  input.currentGit.commit = sha256Commit;
  const full = input.full as ReturnType<typeof summary>;
  full.runtime.git.commit = sha256Commit;
  for (const run of input.criticalRuns as Array<ReturnType<typeof summary>>) run.runtime.git.commit = sha256Commit;
  input.humanReview = human(full);
  const decision = evaluateConversationReleaseGate(input);
  assert.equal(decision.passed, true, decision.failures.join("\n"));
});

test("rejects headline score tampering, duplicate rows, and a weak capability", () => {
  const input = fixture();
  const full = input.full as ReturnType<typeof summary>;
  const directRows = full.results.filter((row) => row.category === "direct-usefulness");
  directRows[0]!.answer = "";
  directRows[1]!.answer = "";
  full.totals.passed = 58;
  full.totals.passRate = 58 / 60;
  full.results[1]!.id = full.results[0]!.id;
  const decision = evaluateConversationReleaseGate(input);
  assert.equal(decision.passed, false);
  assert.match(decision.failures.join("\n"), /reported pass does not match independent frozen-rule scoring/);
  assert.match(decision.failures.join("\n"), /passed total does not match case rows/);
  assert.match(decision.failures.join("\n"), /case IDs are not unique/);
  assert.match(decision.failures.join("\n"), /direct-usefulness requires at least 4\/5/);
});

test("rejects changed synthetic prompts and changed scoring rules", () => {
  const input = fixture();
  const full = input.full as ReturnType<typeof summary>;
  full.results[0]!.input.messages[0]!.content = "An easier substituted request";
  full.results[1]!.input.rule = { any: ["anything"] };
  const decision = evaluateConversationReleaseGate(input);
  assert.equal(decision.passed, false);
  assert.match(decision.failures.join("\n"), /synthetic input or scoring rule differs from the frozen suite/);
});

test("independently rejects a forged passing row whose answer fails the frozen rule", () => {
  const input = fixture();
  const full = input.full as ReturnType<typeof summary>;
  const row = full.results.find((result) => !result.critical)!;
  row.answer = "";
  row.passed = true;
  const decision = evaluateConversationReleaseGate(input);
  assert.equal(decision.passed, false);
  assert.match(decision.failures.join("\n"), /reported pass does not match independent frozen-rule scoring/);
  assert.match(decision.failures.join("\n"), /passed total does not match case rows/);
});

test("rejects warm, mismatched-context, repeated-file, and non-independent runs", () => {
  const input = fixture();
  const runs = input.criticalRuns as Array<ReturnType<typeof summary>>;
  runs[0]!.runtime.runState = "warm-or-unspecified";
  runs[1]!.runtime.model.configuredContext = "8192";
  runs[2]!.startedAt = runs[1]!.startedAt;
  runs[2]!.completedAt = runs[1]!.completedAt;
  input.criticalSourceIds = ["same", "same", "third"];
  const decision = evaluateConversationReleaseGate(input);
  assert.equal(decision.passed, false);
  assert.match(decision.failures.join("\n"), /not declared cold/);
  assert.match(decision.failures.join("\n"), /context differs/);
  assert.match(decision.failures.join("\n"), /distinct private result files/);
  assert.match(decision.failures.join("\n"), /distinct run windows/);
});

test("rejects copied critical bytes and immutable model drift", () => {
  const input = fixture();
  input.sourceDigests.critical[1] = input.sourceDigests.critical[0]!;
  const runs = input.criticalRuns as Array<ReturnType<typeof summary>>;
  runs[0]!.runtime.model.digest = "c".repeat(64);
  runs[1]!.runtime.model.details = { ...modelDetails, quantization_level: "Q8_0" };
  const decision = evaluateConversationReleaseGate(input);
  assert.equal(decision.passed, false);
  assert.match(decision.failures.join("\n"), /distinct source byte sequences/);
  assert.match(decision.failures.join("\n"), /immutable model digest differs/);
  assert.match(decision.failures.join("\n"), /quantization or details differ/);
});

test("rejects missing mandatory runtime, host, and per-row latency provenance", () => {
  const cases: Array<{ mutate: (input: ConversationReleaseGateInput) => void; expected: RegExp }> = [
    {
      mutate: (input) => { delete ((input.full as ReturnType<typeof summary>).runtime.ollama as Record<string, unknown>).version; },
      expected: /runtime\.ollama\.version must be a non-empty string/,
    },
    {
      mutate: (input) => { delete ((input.full as ReturnType<typeof summary>).runtime.host as Record<string, unknown>).cpu; },
      expected: /runtime\.host\.cpu must be a non-empty string/,
    },
    {
      mutate: (input) => { delete ((input.full as ReturnType<typeof summary>).results[0]! as Record<string, unknown>).latencyMs; },
      expected: /results\[0\]\.latencyMs must be a finite number/,
    },
    {
      mutate: (input) => { delete (input.full as Record<string, unknown>).averageLatencyMs; },
      expected: /averageLatencyMs must be a finite number/,
    },
  ];
  for (const item of cases) {
    const input = fixture();
    item.mutate(input);
    const decision = evaluateConversationReleaseGate(input);
    assert.equal(decision.passed, false);
    assert.match(decision.failures.join("\n"), item.expected);
  }
});

test("rejects malformed hardware and runtime provenance", () => {
  const input = fixture();
  const full = input.full as ReturnType<typeof summary>;
  full.runtime.host.logicalCpuCount = 0;
  full.runtime.host.totalMemoryBytes = -1;
  full.runtime.host.node = "Node latest";
  const decision = evaluateConversationReleaseGate(input);
  assert.equal(decision.passed, false);
  assert.match(decision.failures.join("\n"), /logicalCpuCount must be a positive integer/);

  const memoryInput = fixture();
  (memoryInput.full as ReturnType<typeof summary>).runtime.host.totalMemoryBytes = -1;
  const memoryDecision = evaluateConversationReleaseGate(memoryInput);
  assert.equal(memoryDecision.passed, false);
  assert.match(memoryDecision.failures.join("\n"), /totalMemoryBytes must be a positive integer/);

  const nodeInput = fixture();
  (nodeInput.full as ReturnType<typeof summary>).runtime.host.node = "Node latest";
  const nodeDecision = evaluateConversationReleaseGate(nodeInput);
  assert.equal(nodeDecision.passed, false);
  assert.match(nodeDecision.failures.join("\n"), /must be a versioned Node\.js runtime/);

  const ollamaInput = fixture();
  (ollamaInput.full as ReturnType<typeof summary>).runtime.ollama.version = "latest";
  const ollamaDecision = evaluateConversationReleaseGate(ollamaInput);
  assert.equal(ollamaDecision.passed, false);
  assert.match(ollamaDecision.failures.join("\n"), /must be a versioned Ollama runtime/);
});

test("recomputes latency aggregate and validates the run window", () => {
  const aggregateInput = fixture();
  (aggregateInput.full as ReturnType<typeof summary>).averageLatencyMs = 999;
  const aggregateDecision = evaluateConversationReleaseGate(aggregateInput);
  assert.equal(aggregateDecision.passed, false);
  assert.match(aggregateDecision.failures.join("\n"), /average latency does not match completed case rows/);

  const durationInput = fixture();
  const full = durationInput.full as ReturnType<typeof summary>;
  full.completedAt = "2026-08-10T01:00:01.000Z";
  const durationDecision = evaluateConversationReleaseGate(durationInput);
  assert.equal(durationDecision.passed, false);
  assert.match(durationDecision.failures.join("\n"), /wall-clock duration is shorter than summed per-row latency/);
});

test("requires the same Ollama, host, and native model profile across repeated runs", () => {
  const input = fixture();
  const runs = input.criticalRuns as Array<ReturnType<typeof summary>>;
  runs[0]!.runtime.ollama.version = "0.11.5";
  runs[1]!.runtime.host.cpu = "Different CPU";
  runs[2]!.runtime.model.contextLength = 65_536;
  const decision = evaluateConversationReleaseGate(input);
  assert.equal(decision.passed, false);
  assert.match(decision.failures.join("\n"), /Ollama version differs/);
  assert.match(decision.failures.join("\n"), /host hardware\/runtime profile differs/);
  assert.match(decision.failures.join("\n"), /model native context length differs/);
});

test("fails closed when required source digests are missing or malformed", () => {
  const input = fixture();
  input.sourceDigests.full = "not-a-digest";
  input.sourceDigests.human = "";
  const decision = evaluateConversationReleaseGate(input);
  assert.equal(decision.passed, false);
  assert.match(decision.failures.join("\n"), /full source digest must be a SHA-256 digest/);
});

test("rejects critical evidence that omits, fails, or substitutes a frozen case", () => {
  const input = fixture();
  const run = input.criticalRuns[0] as ReturnType<typeof summary>;
  run.results[0]!.answer = "";
  run.results[0]!.passed = false;
  run.results[1]!.id = "substituted-case";
  const decision = evaluateConversationReleaseGate(input);
  assert.equal(decision.passed, false);
  assert.match(decision.failures.join("\n"), /contains a noncritical or independently failing case/);
  assert.match(decision.failures.join("\n"), /case set differs/);
});

test("rejects a spoofed human pass when ratings, trust flags, or gates disagree", () => {
  const input = fixture();
  const review = input.humanReview as ReturnType<typeof human>;
  review.items[0]!.rating = 2;
  review.items[1]!.privacyFailure = true;
  review.gates.criticalItems.passed = false;
  const decision = evaluateConversationReleaseGate(input);
  assert.equal(decision.passed, false);
  assert.match(decision.failures.join("\n"), /mean rating does not match/);
  assert.match(decision.failures.join("\n"), /every item must be at least 3\/5/);
  assert.match(decision.failures.join("\n"), /material trust failure/);
  assert.match(decision.failures.join("\n"), /critical-item gate/);
});

test("release gate rejects automated reviewer identities and false human attestations", () => {
  const automated = fixture();
  (automated.humanReview as ReturnType<typeof human>).reviewer = "Rangabot AI model";
  const automatedDecision = evaluateConversationReleaseGate(automated);
  assert.equal(automatedDecision.passed, false);
  assert.match(automatedDecision.failures.join("\n"), /reviewer identity names an AI/iu);

  const unattested = fixture();
  (unattested.humanReview as ReturnType<typeof human>).attestation.humanReviewer = false;
  const unattestedDecision = evaluateConversationReleaseGate(unattested);
  assert.equal(unattestedDecision.passed, false);
  assert.match(unattestedDecision.failures.join("\n"), /human-only, no-automation/iu);
});

test("rejects replaying a human result against different stochastic answer bytes", () => {
  const input = fixture();
  const full = input.full as ReturnType<typeof summary>;
  const selectedId = createBlindReview(full as unknown as ConversationEvaluationForReview).key.items[0]!.caseId;
  full.results.find((result) => result.id === selectedId)!.answer += " Different stochastic continuation.";
  const decision = evaluateConversationReleaseGate(input);
  assert.equal(decision.passed, false);
  assert.match(decision.failures.join("\n"), /packet does not bind to the supplied full result's selected inputs and answers/);
});

test("recomputes critical ratings instead of trusting a forged passing gate boolean", () => {
  const input = fixture();
  const review = input.humanReview as ReturnType<typeof human>;
  const critical = review.items.find((item) => item.critical)!;
  const noncritical = review.items.find((item) => !item.critical)!;
  critical.rating = 3;
  noncritical.rating = 5;
  review.meanRating = 4;
  review.gates.mean.value = 4;
  review.gates.criticalItems = { passed: true, failures: [], minimum: 4 };
  review.passed = true;
  const decision = evaluateConversationReleaseGate(input);
  assert.equal(decision.passed, false);
  assert.match(decision.failures.join("\n"), /every critical item must be at least 4\/5/);
});

test("rejects human evidence for the wrong suite", () => {
  const input = fixture();
  (input.humanReview as ReturnType<typeof human>).suiteVersion = "1.0.11";
  const decision = evaluateConversationReleaseGate(input);
  assert.equal(decision.passed, false);
  assert.match(decision.failures.join("\n"), /suite version does not match/);
});

test("rejects a review timestamp that predates full-answer generation", () => {
  const input = fixture();
  (input.humanReview as ReturnType<typeof human>).reviewedAt = "2026-08-10T00:00:00.000Z";
  const decision = evaluateConversationReleaseGate(input);
  assert.equal(decision.passed, false);
  assert.match(decision.failures.join("\n"), /review predates completion/);
});

test("rejects dirty or stale candidates and requires exactly three critical runs", () => {
  const input = fixture();
  input.currentGit.dirty = true;
  (input.full as { suite: { version: string } }).suite.version = "1.0.11";
  input.criticalRuns.pop();
  const decision = evaluateConversationReleaseGate(input);
  assert.equal(decision.passed, false);
  assert.match(decision.failures.join("\n"), /current Git worktree is dirty/);
  assert.match(decision.failures.join("\n"), /requires frozen suite 1.0.12/);
  assert.match(decision.failures.join("\n"), /exactly 3 critical-only runs/);
});

test("CLI exits nonzero rather than offering a bypass when evidence is absent", () => {
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/check-conversation-release.ts"], { cwd: process.cwd(), encoding: "utf8" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Conversation release gate: FAIL/);
  assert.match(run.stderr, /--full=<result\.json>/);
  const bypass = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/check-conversation-release.ts", "--bypass"], { cwd: process.cwd(), encoding: "utf8" });
  assert.notEqual(bypass.status, 0);
  assert.match(bypass.stderr, /Unknown release-gate argument: --bypass/);
});
