import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  type ConversationCapability,
  type ConversationEvaluationForReview,
} from "../lib/conversation-human-review.ts";

const capabilities: ConversationCapability[] = [
  "direct-usefulness", "format-adherence", "continuity", "correction-precedence",
  "honest-uncertainty", "reasoning", "adaptation", "memory-use", "memory-privacy",
  "memory-precedence", "unavailable-actions", "scope-judgment",
];
const trust = new Set(["correction-precedence", "honest-uncertainty", "reasoning", "memory-privacy", "memory-precedence", "unavailable-actions"]);

function fixture(): ConversationEvaluationForReview {
  return {
    suite: { name: "rangabot-core-conversation", version: conversationHumanReviewProtocol.suiteVersion },
    runtime: { git: { commit: "a".repeat(40), dirty: false }, model: { hidden: true } },
    selection: { completeSuite: true },
    totals: { total: 60, completed: 60, errors: 0 },
    results: capabilities.flatMap((category) => Array.from({ length: 5 }, (_, index) => ({
      id: `${category}-${index + 1}`,
      category,
      critical: trust.has(category) ? index < 3 : false,
      input: {
        messages: [{ role: "user" as const, content: `Synthetic request ${category} ${index + 1}` }],
        memories: category.startsWith("memory-") ? [{ kind: "preference", content: "Synthetic approved preference" }] : [],
      },
      answer: `Synthetic answer ${category} ${index + 1}`,
      passed: true,
    }))),
  };
}

test("creates one deterministic, identity-blind item per conversation capability", () => {
  const first = createBlindReview(fixture());
  const second = createBlindReview(fixture());
  assert.deepEqual(first, second);
  assert.equal(first.packet.items.length, 12);
  assert.equal(new Set(first.packet.items.map((item) => item.itemId)).size, 12);
  assert.equal(first.key.items.filter((item) => item.critical).length, 6);
  const visible = JSON.stringify(first.packet);
  for (const forbidden of ["caseId", "category", "critical", "automaticPass", "model", "commit"]) assert.doesNotMatch(visible, new RegExp(`"${forbidden}"\\s*:`, "i"));
  assert.deepEqual(first.ratings.items.map((item) => item.rating), Array(12).fill(null));
  assert.deepEqual(first.ratings.attestation, {
    humanReviewer: false,
    completedWithoutAutomatedAssistance: false,
    ratingsFinalizedBeforeKey: false,
    statement: conversationHumanReviewAttestationStatement,
  });
  assert.equal(first.packet.packetId.length, 64);

  const changedAnswer = fixture();
  changedAnswer.results.find((result) => result.id === first.key.items[0]!.caseId)!.answer += " changed";
  assert.notEqual(createBlindReview(changedAnswer).packet.packetId, first.packet.packetId);
  const changedInput = fixture();
  changedInput.results.find((result) => result.id === first.key.items[0]!.caseId)!.input.messages[0]!.content += " changed";
  assert.notEqual(createBlindReview(changedInput).packet.packetId, first.packet.packetId);
});

test("fails closed for incomplete, dirty, stale, or input-less evaluations", () => {
  const incomplete = fixture();
  incomplete.totals.completed = 59;
  assert.throws(() => createBlindReview(incomplete), /incomplete or errored/);
  const dirty = fixture();
  dirty.runtime.git.dirty = true;
  assert.throws(() => createBlindReview(dirty), /clean, identified Git candidate/);
  const stale = fixture();
  stale.suite.version = "1.0.10";
  assert.throws(() => createBlindReview(stale), /frozen conversation suite/);
  const missingInput = fixture();
  delete (missingInput.results[0] as Partial<(typeof missingInput.results)[number]>).input;
  assert.throws(() => createBlindReview(missingInput), /predates the blind-review input schema/);
});

function completedRatings(packetId: string, rating = 4): BlindReviewRatings {
  return {
    schemaVersion: 2,
    protocolVersion: conversationHumanReviewProtocol.version,
    packetId,
    reviewer: "Human reviewer",
    reviewedAt: "2026-08-10T00:00:00.000Z",
    attestation: {
      humanReviewer: true,
      completedWithoutAutomatedAssistance: true,
      ratingsFinalizedBeforeKey: true,
      statement: conversationHumanReviewAttestationStatement,
    },
    items: Array.from({ length: 12 }, (_, index) => ({ itemId: `R${String(index + 1).padStart(2, "0")}`, rating, privacyFailure: false, fabricatedAction: false, materialTruthFailure: false, note: "" })),
  };
}

test("enforces mean, per-item, critical, and material-trust human gates", () => {
  const { key } = createBlindReview(fixture());
  const passing = scoreBlindReview(key, completedRatings(key.packetId));
  assert.equal(passing.passed, true);
  assert.equal(passing.meanRating, 4);
  assert.equal(passing.suiteVersion, conversationHumanReviewProtocol.suiteVersion);
  assert.deepEqual(passing.attestation, completedRatings(key.packetId).attestation);
  assert.equal(passing.items.filter((item) => item.critical).length, 6);

  const lowCritical = completedRatings(key.packetId, 5);
  const criticalId = key.items.find((item) => item.critical)!.itemId;
  lowCritical.items.find((item) => item.itemId === criticalId)!.rating = 3;
  assert.equal(scoreBlindReview(key, lowCritical).gates.criticalItems.passed, false);

  const materialFailure = completedRatings(key.packetId, 5);
  materialFailure.items[0]!.privacyFailure = true;
  assert.equal(scoreBlindReview(key, materialFailure).gates.materialTrust.passed, false);

  const missing = completedRatings(key.packetId);
  missing.items[0]!.rating = null;
  assert.throws(() => scoreBlindReview(key, missing), /integer from 1 to 5/);
});

test("rejects automated reviewer identities and incomplete or altered human attestations", () => {
  const { key } = createBlindReview(fixture());
  for (const reviewer of ["Codex", "Rangabot", "AI reviewer", "A.I. reviewer", "Local model", "ChatGPT", "Qwen bot"]) {
    const ratings = completedRatings(key.packetId);
    ratings.reviewer = reviewer;
    assert.throws(() => scoreBlindReview(key, ratings), /must identify a human/iu, reviewer);
  }

  const falseAttestation = completedRatings(key.packetId);
  falseAttestation.attestation.completedWithoutAutomatedAssistance = false;
  assert.throws(() => scoreBlindReview(key, falseAttestation), /human-only, no-automation/iu);

  const alteredStatement = completedRatings(key.packetId);
  alteredStatement.attestation.statement = "I am probably human.";
  assert.throws(() => scoreBlindReview(key, alteredStatement), /human-only, no-automation/iu);
});

test("keeps blind-review artifacts Git-ignored and owner-only", () => {
  const ignore = readFileSync(resolve(".gitignore"), "utf8").split(/\r?\n/);
  assert.ok(ignore.includes("data/evaluations/reviews/"));
  const ignored = spawnSync("git", ["check-ignore", "--quiet", "data/evaluations/reviews/private-review.json"], { cwd: process.cwd() });
  assert.equal(ignored.status, 0, "Git must ignore every blind-review artifact");

  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "rangabot-human-review-private-")));
  try {
    const privateRoot = join(temporary, "data", "evaluations");
    const inputRoot = join(privateRoot, "results");
    mkdirSync(inputRoot, { recursive: true, mode: 0o700 });
    const inputPath = join(inputRoot, "complete.json");
    writeFileSync(inputPath, JSON.stringify(fixture()), { mode: 0o600 });
    const run = spawnSync(process.execPath, [
      "--experimental-strip-types",
      resolve("scripts/conversation-human-review.ts"),
      "prepare",
      `--result=${inputPath}`,
    ], { cwd: temporary, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
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

test("human-review scorer CLI writes evidence but exits nonzero when the review fails", () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "rangabot-human-review-")));
  try {
    const privateRoot = join(temporary, "data", "evaluations");
    mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
    const { key } = createBlindReview(fixture());
    const ratings = completedRatings(key.packetId, 1);
    const keyPath = join(privateRoot, "key.json");
    const ratingsPath = join(privateRoot, "ratings.json");
    writeFileSync(keyPath, JSON.stringify(key), { mode: 0o600 });
    writeFileSync(ratingsPath, JSON.stringify(ratings), { mode: 0o600 });
    const run = spawnSync(process.execPath, [
      "--experimental-strip-types",
      resolve("scripts/conversation-human-review.ts"),
      "score",
      `--key=${keyPath}`,
      `--ratings=${ratingsPath}`,
    ], { cwd: temporary, encoding: "utf8" });
    assert.notEqual(run.status, 0);
    assert.match(run.stdout, /Human usefulness: 1\.00\/5 \(FAIL\)/, run.stderr);
    assert.match(run.stdout, /Private review result:/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
