import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  conversationHumanReviewAttestationStatement,
  conversationHumanReviewProtocol,
  createBlindReview,
  scoreBlindReview,
  type BlindReviewRatings,
  type ConversationEvaluationForReview,
} from "../lib/conversation-human-review.ts";
import {
  conversationEvaluationCases,
  scoreConversationEvaluationAnswer,
} from "../lib/conversation-evaluation-suite.ts";

const commit = "a".repeat(40);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const sourceDigests = {
  full: digest("full-source"),
  critical: [digest("critical-source-1"), digest("critical-source-2"), digest("critical-source-3")],
};

function passingAnswer(testCase: (typeof conversationEvaluationCases)[number]) {
  const rule = testCase.rule;
  if (testCase.id === "false-premise-01") {
    return "The premise is mistaken. Python may be interpreted, but indentation has no influence on program behavior and is merely visual.";
  }
  if (rule.matches?.includes("^YES$")) return "YES";
  if (rule.matches?.some((pattern) => pattern.includes("[a-z]+,[a-z]+"))) return "safe,clear,tested,stable";
  const content = [...(rule.all ?? []), ...(rule.allAny ?? []).map((group) => group[0]!), ...(rule.any?.slice(0, 1) ?? [])].join(" ") || "useful answer";
  if (rule.numberedItems) return Array.from({ length: rule.numberedItems }, (_, index) => `${index + 1}. ${index ? "check" : content}`).join("\n");
  if (rule.bulletItems) return Array.from({ length: rule.bulletItems }, (_, index) => `- ${index ? "detail" : content}`).join("\n");
  if (rule.outlineItems) return Array.from({ length: rule.outlineItems }, (_, index) => `${index + 1}. ${index ? "section" : content}`).join("\n");
  return content;
}

function rows() {
  return conversationEvaluationCases.map((testCase) => ({
    id: testCase.id,
    category: testCase.category,
    critical: Boolean(testCase.critical),
    input: {
      messages: structuredClone(testCase.messages),
      memories: structuredClone(testCase.memories ?? []),
    },
    answer: passingAnswer(testCase),
    passed: scoreConversationEvaluationAnswer(passingAnswer(testCase), testCase.rule).passed,
  }));
}

function evaluation(criticalOnly = false, run = 0): ConversationEvaluationForReview {
  const selected = rows().filter((result) => !criticalOnly || result.critical);
  return {
    suite: { name: "rangabot-core-conversation", version: conversationHumanReviewProtocol.suiteVersion },
    startedAt: `2026-08-10T0${run}:00:00.000Z`,
    completedAt: `2026-08-10T0${run}:10:00.000Z`,
    runtime: {
      git: { commit, dirty: false },
      model: { name: "synthetic:3b", digest: digest("model") },
      ollama: { version: "0.32.4" },
      host: { profile: "synthetic" },
      runState: "cold-declared",
    },
    selection: { completeSuite: !criticalOnly, criticalOnly, requestedIds: [] },
    totals: { total: selected.length, completed: selected.length, errors: 0 },
    results: selected,
  };
}

function sources() {
  return {
    full: evaluation(false, 0),
    critical: [evaluation(true, 1), evaluation(true, 2), evaluation(true, 3)],
    digests: structuredClone(sourceDigests),
  };
}

function createReview(input = sources()) {
  return createBlindReview(input.full, input.critical, input.digests);
}

function completedRatings(packetId: string, itemCount: number, rating = 4): BlindReviewRatings {
  return {
    schemaVersion: 3,
    protocolVersion: conversationHumanReviewProtocol.version,
    packetId,
    reviewer: "Human reviewer",
    reviewedAt: "2026-08-10T04:00:00.000Z",
    attestation: {
      humanReviewer: true,
      completedWithoutAutomatedAssistance: true,
      ratingsFinalizedBeforeKey: true,
      statement: conversationHumanReviewAttestationStatement,
    },
    items: Array.from({ length: itemCount }, (_, index) => ({ itemId: `R${String(index + 1).padStart(2, "0")}`, rating, privacyFailure: false, fabricatedAction: false, materialTruthFailure: false, note: "" })),
  };
}

test("creates a deterministic 15-item blind packet bound to full and three critical sources", () => {
  const first = createReview();
  const second = createReview();
  assert.deepEqual(first, second);
  assert.equal(first.packet.items.length, 15);
  assert.equal(new Set(first.packet.items.map((item) => item.itemId)).size, 15);
  assert.equal(first.key.items.filter((item) => item.humanSemanticReviewRequired).length, 4);
  assert.deepEqual(new Set(first.key.items.filter((item) => item.humanSemanticReviewRequired).map((item) => item.sourceSlot)), new Set(["full", "critical-1", "critical-2", "critical-3"]));
  assert.equal(first.key.items.filter((item) => item.critical).length, 9);
  const visible = JSON.stringify(first.packet);
  for (const forbidden of ["caseId", "category", "critical", "automaticPass", "humanSemanticReviewRequired", "sourceSlot", "sourceDigest", "model", "commit"]) {
    assert.doesNotMatch(visible, new RegExp(`"${forbidden}"\\s*:`, "i"));
  }
  assert.deepEqual(first.ratings.items.map((item) => item.rating), Array(15).fill(null));
  assert.equal(first.packet.packetId.length, 64);
});

test("forces the human-required full case and all repeated outputs into human judgment", () => {
  const input = sources();
  const falsePremise = conversationEvaluationCases.find((testCase) => testCase.id === "false-premise-01")!;
  const wrongAnswer = input.full.results.find((result) => result.id === falsePremise.id)!.answer;
  assert.equal(scoreConversationEvaluationAnswer(wrongAnswer, falsePremise.rule).passed, true, "legacy lexical rule intentionally remains unchanged");
  const { packet, key } = createReview(input);
  const required = key.items.filter((item) => item.humanSemanticReviewRequired);
  assert.equal(required.length, 4);
  assert.ok(required.every((item) => item.caseId === "false-premise-01"));
  assert.ok(required.every((item) => item.automaticPass), "lexical passes must still remain human-gated");
  assert.ok(required.every((item) => packet.items.find((visible) => visible.itemId === item.itemId)?.answer.includes("no influence")));

  const ratings = completedRatings(key.packetId, key.items.length, 5);
  ratings.items.find((item) => item.itemId === required[0]!.itemId)!.rating = 3;
  const result = scoreBlindReview(key, ratings);
  assert.equal(result.passed, false);
  assert.deepEqual(result.gates.humanSemanticItems.failures, [required[0]!.itemId]);

  const forged = completedRatings(key.packetId, key.items.length, 5);
  const forgedSemantic = forged.items.find((item) => item.itemId === required[0]!.itemId)! as typeof forged.items[number] & {
    critical: boolean;
    humanSemanticReviewRequired: boolean;
  };
  forgedSemantic.rating = 3;
  forgedSemantic.critical = false;
  forgedSemantic.humanSemanticReviewRequired = false;
  const forgedResult = scoreBlindReview(key, forged);
  assert.equal(forgedResult.passed, false, "ratings cannot override authoritative key provenance");
  assert.deepEqual(forgedResult.gates.humanSemanticItems.failures, [required[0]!.itemId]);
});

test("binds packet identity to selected input, answer, source bytes, provenance, and run order", () => {
  const baseline = createReview().packet.packetId;
  const changedAnswer = sources();
  changedAnswer.critical[1]!.results.find((result) => result.id === "false-premise-01")!.answer += " changed";
  assert.notEqual(createReview(changedAnswer).packet.packetId, baseline);

  const changedInput = sources();
  changedInput.full.results.find((result) => result.id === "false-premise-01")!.input.messages[0]!.content += " changed";
  assert.notEqual(createReview(changedInput).packet.packetId, baseline);

  const changedBytes = sources();
  changedBytes.digests.critical[2] = digest("different-source-bytes");
  assert.notEqual(createReview(changedBytes).packet.packetId, baseline);

  const missing = sources();
  missing.critical.pop();
  assert.throws(() => createReview(missing), /exactly 3 critical-only results/);

  const swapped = sources();
  [swapped.critical[0], swapped.critical[1]] = [swapped.critical[1]!, swapped.critical[0]!];
  [swapped.digests.critical[0], swapped.digests.critical[1]] = [swapped.digests.critical[1]!, swapped.digests.critical[0]!];
  assert.throws(() => createReview(swapped), /chronological, non-overlapping order/);
});

test("fails closed for incomplete, dirty, stale, input-less, or replayed evaluations", () => {
  const incomplete = sources();
  incomplete.full.totals.completed = 59;
  assert.throws(() => createReview(incomplete), /incomplete or errored full result/);
  const dirty = sources();
  dirty.full.runtime.git.dirty = true;
  assert.throws(() => createReview(dirty), /clean, identified Git candidate/);
  const stale = sources();
  stale.full.suite.version = "1.0.12";
  assert.throws(() => createReview(stale), /frozen conversation suite/);
  const missingInput = sources();
  delete (missingInput.full.results[0] as Partial<(typeof missingInput.full.results)[number]>).input;
  assert.throws(() => createReview(missingInput), /predates the blind-review input schema/);
  const replayedBytes = sources();
  replayedBytes.digests.critical[1] = replayedBytes.digests.critical[0]!;
  assert.throws(() => createReview(replayedBytes), /four distinct source byte digests/);
});

test("enforces mean, per-item, critical, semantic, and material-trust human gates", () => {
  const { key } = createReview();
  const passing = scoreBlindReview(key, completedRatings(key.packetId, key.items.length));
  assert.equal(passing.passed, true);
  assert.equal(passing.meanRating, 4);
  assert.equal(passing.suiteVersion, conversationHumanReviewProtocol.suiteVersion);

  const lowCritical = completedRatings(key.packetId, key.items.length, 5);
  const criticalId = key.items.find((item) => item.critical)!.itemId;
  lowCritical.items.find((item) => item.itemId === criticalId)!.rating = 3;
  assert.equal(scoreBlindReview(key, lowCritical).gates.criticalItems.passed, false);

  const materialFailure = completedRatings(key.packetId, key.items.length, 5);
  materialFailure.items[0]!.privacyFailure = true;
  assert.equal(scoreBlindReview(key, materialFailure).gates.materialTrust.passed, false);

  const missing = completedRatings(key.packetId, key.items.length);
  missing.items[0]!.rating = null;
  assert.throws(() => scoreBlindReview(key, missing), /integer from 1 to 5/);
});

test("rejects automated reviewer identities and incomplete or altered human attestations", () => {
  const { key } = createReview();
  for (const reviewer of ["Codex", "Rangabot", "AI reviewer", "A.I. reviewer", "Local model", "ChatGPT", "Qwen bot"]) {
    const ratings = completedRatings(key.packetId, key.items.length);
    ratings.reviewer = reviewer;
    assert.throws(() => scoreBlindReview(key, ratings), /must identify a human/iu, reviewer);
  }
  const falseAttestation = completedRatings(key.packetId, key.items.length);
  falseAttestation.attestation.completedWithoutAutomatedAssistance = false;
  assert.throws(() => scoreBlindReview(key, falseAttestation), /human-only, no-automation/iu);
});

test("keeps four-source blind-review artifacts Git-ignored and owner-only", () => {
  const ignore = readFileSync(resolve(".gitignore"), "utf8").split(/\r?\n/);
  assert.ok(ignore.includes("data/evaluations/reviews/"));
  assert.equal(spawnSync("git", ["check-ignore", "--quiet", "data/evaluations/reviews/private-review.json"], { cwd: process.cwd() }).status, 0);

  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "rangabot-human-review-private-")));
  try {
    const privateRoot = join(temporary, "data", "evaluations");
    const inputRoot = join(privateRoot, "results");
    mkdirSync(inputRoot, { recursive: true, mode: 0o700 });
    const input = sources();
    const fullPath = join(inputRoot, "complete.json");
    const criticalPaths = input.critical.map((summary, index) => {
      const path = join(inputRoot, `critical-${index + 1}.json`);
      writeFileSync(path, JSON.stringify(summary), { mode: 0o600 });
      return path;
    });
    writeFileSync(fullPath, JSON.stringify(input.full), { mode: 0o600 });
    const run = spawnSync(process.execPath, [
      "--experimental-strip-types",
      resolve("scripts/conversation-human-review.ts"),
      "prepare",
      `--full=${fullPath}`,
      ...criticalPaths.map((path) => `--critical=${path}`),
    ], { cwd: temporary, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const unknown = spawnSync(process.execPath, [
      "--experimental-strip-types",
      resolve("scripts/conversation-human-review.ts"),
      "prepare",
      `--full=${fullPath}`,
      ...criticalPaths.map((path) => `--critical=${path}`),
      "--bypass",
    ], { cwd: temporary, encoding: "utf8" });
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /Unknown human-review argument: --bypass/);
    const reviewRoot = join(privateRoot, "reviews");
    assert.equal(readdirSync(reviewRoot).length, 3);
    if (process.platform !== "win32") {
      assert.equal(statSync(reviewRoot).mode & 0o777, 0o700);
      for (const name of readdirSync(reviewRoot)) assert.equal(statSync(join(reviewRoot, name)).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("prepare CLI rejects an omitted critical run", () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "rangabot-human-review-missing-")));
  try {
    const privateRoot = join(temporary, "data", "evaluations");
    mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
    const input = sources();
    const fullPath = join(privateRoot, "full.json");
    const criticalPath = join(privateRoot, "critical.json");
    writeFileSync(fullPath, JSON.stringify(input.full), { mode: 0o600 });
    writeFileSync(criticalPath, JSON.stringify(input.critical[0]), { mode: 0o600 });
    const run = spawnSync(process.execPath, ["--experimental-strip-types", resolve("scripts/conversation-human-review.ts"), "prepare", `--full=${fullPath}`, `--critical=${criticalPath}`], { cwd: temporary, encoding: "utf8" });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /exactly|--critical/iu);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("human-review scorer CLI writes evidence but exits nonzero when the review fails", () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "rangabot-human-review-")));
  try {
    const privateRoot = join(temporary, "data", "evaluations");
    mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
    const { key } = createReview();
    const ratings = completedRatings(key.packetId, key.items.length, 1);
    const keyPath = join(privateRoot, "key.json");
    const ratingsPath = join(privateRoot, "ratings.json");
    writeFileSync(keyPath, JSON.stringify(key), { mode: 0o600 });
    writeFileSync(ratingsPath, JSON.stringify(ratings), { mode: 0o600 });
    const run = spawnSync(process.execPath, ["--experimental-strip-types", resolve("scripts/conversation-human-review.ts"), "score", `--key=${keyPath}`, `--ratings=${ratingsPath}`], { cwd: temporary, encoding: "utf8" });
    assert.notEqual(run.status, 0);
    assert.match(run.stdout, /Human usefulness: 1\.00\/5 \(FAIL\)/, run.stderr);
    assert.match(run.stdout, /Private review result:/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
