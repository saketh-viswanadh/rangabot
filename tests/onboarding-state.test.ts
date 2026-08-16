import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  completeOnboardingState,
  ONBOARDING_MAX_BYTES,
  OnboardingConflictError,
  parseOnboardingMutation,
  parseOnboardingState,
  readOnboardingState,
  updateOnboardingState,
  writeInitialOnboardingState,
} from "../lib/onboarding-state.ts";
import { formatOnboardingTimestamp, onboardingNeedsStart, onboardingStepAfterRefresh } from "../lib/onboarding-contract.ts";

function fixture(prefix = "rangabot-onboarding-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, path: join(root, "onboarding-state.json") };
}

const receipt = {
  selectedModel: "qwen3:8b",
  selectedModelState: "installed-reviewed" as const,
  approvedWorkFolders: 2,
  knowledgeDocuments: 3,
};

test("conflict refresh helpers resynchronize the saved step without retrying an already active setup", () => {
  assert.equal(onboardingStepAfterRefresh({ status: "in-progress", step: "context" }), "context");
  assert.equal(onboardingNeedsStart({ status: "in-progress" }), false);
  assert.equal(onboardingStepAfterRefresh({ status: "completed", step: "ready" }), "ready");
  assert.equal(onboardingNeedsStart({ status: "completed" }), false);
  assert.equal(onboardingStepAfterRefresh({ status: "dismissed", step: "welcome" }), "welcome");
  assert.equal(onboardingNeedsStart({ status: "dismissed" }), true);
  assert.equal(formatOnboardingTimestamp("2026-08-15T12:34:56.000Z"), "2026-08-15 12:34:56 UTC");
});

test("uses a versioned private profile-owned state and an available missing-state fallback", () => {
  const { root, path } = fixture();
  try {
    assert.deepEqual(readOnboardingState({ path }), {
      schemaVersion: 1,
      flowVersion: 1,
      status: "available",
      step: "you",
      revision: 0,
      startedAt: null,
      dismissedAt: null,
      completedAt: null,
      receipt: null,
      updatedAt: null,
    });
    const pending = writeInitialOnboardingState({ path, trustedDataRoot: root, status: "pending" });
    assert.equal(pending.status, "pending");
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, "utf8"))).sort(), [
      "completedAt", "dismissedAt", "flowVersion", "receipt", "revision", "schemaVersion",
      "startedAt", "status", "step", "updatedAt",
    ]);
    if (process.platform !== "win32") assert.equal(lstatSync(path).mode & 0o777, 0o600);
    assert.equal(writeInitialOnboardingState({ path, trustedDataRoot: root, status: "available" }).status, "pending");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("enforces start, adjacent navigation, dismissal, resume, Ready completion, and durable replay", () => {
  const { root, path } = fixture();
  try {
    writeInitialOnboardingState({ path, trustedDataRoot: root, status: "pending" });
    assert.throws(
      () => completeOnboardingState({ expectedRevision: 0, receipt }, { path, trustedDataRoot: root }),
      /saved Ready step/,
    );
    assert.throws(
      () => updateOnboardingState({ action: "advance", expectedRevision: 0, step: "model" }, { path, trustedDataRoot: root }),
      /one saved step/,
    );
    const started = updateOnboardingState(
      { action: "start", expectedRevision: 0, step: "you" },
      { path, trustedDataRoot: root, now: "2026-08-15T00:00:00.000Z" },
    );
    assert.equal(started.status, "in-progress");
    assert.throws(
      () => updateOnboardingState({ action: "advance", expectedRevision: 1, step: "ready" }, { path, trustedDataRoot: root }),
      /one saved step/,
    );
    const model = updateOnboardingState({ action: "advance", expectedRevision: 1, step: "model" }, { path, trustedDataRoot: root });
    assert.equal(model.step, "model");
    assert.throws(
      () => updateOnboardingState({ action: "advance", expectedRevision: 2, step: "context" }, { path, trustedDataRoot: root }),
      /one saved step/,
    );
    const back = updateOnboardingState({ action: "advance", expectedRevision: 2, step: "you" }, { path, trustedDataRoot: root });
    assert.equal(back.step, "you");
    const dismissed = updateOnboardingState({ action: "dismiss", expectedRevision: 3, step: "you" }, { path, trustedDataRoot: root });
    assert.equal(dismissed.status, "dismissed");
    assert.throws(
      () => updateOnboardingState({ action: "advance", expectedRevision: 4, step: "model" }, { path, trustedDataRoot: root }),
      /one saved step/,
    );
    updateOnboardingState({ action: "start", expectedRevision: 4, step: "you" }, { path, trustedDataRoot: root });
    updateOnboardingState({ action: "advance", expectedRevision: 5, step: "model" }, { path, trustedDataRoot: root });
    updateOnboardingState({ action: "advance", expectedRevision: 6, step: "welcome" }, { path, trustedDataRoot: root });
    updateOnboardingState({ action: "advance", expectedRevision: 7, step: "context" }, { path, trustedDataRoot: root });
    updateOnboardingState({ action: "advance", expectedRevision: 8, step: "ready" }, { path, trustedDataRoot: root });
    const completed = completeOnboardingState(
      { expectedRevision: 9, receipt },
      { path, trustedDataRoot: root, now: "2026-08-15T01:00:00.000Z" },
    );
    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.receipt, { ...receipt, completedAt: "2026-08-15T01:00:00.000Z", localOnly: true });
    assert.throws(
      () => updateOnboardingState({ action: "start", expectedRevision: 10, step: "ready" }, { path, trustedDataRoot: root }),
      /durable receipt/,
    );
    assert.throws(
      () => completeOnboardingState({ expectedRevision: 10, receipt: { ...receipt, approvedWorkFolders: 9 } }, { path, trustedDataRoot: root }),
      /durable receipt/,
    );
    assert.deepEqual(readOnboardingState({ path }).receipt, completed.receipt);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("client completion cannot forge a receipt and authoritative counts are bounded", () => {
  const { root, path } = fixture();
  try {
    assert.deepEqual(parseOnboardingMutation({ action: "complete", expectedRevision: 4 }), {
      action: "complete", expectedRevision: 4,
    });
    assert.throws(
      () => parseOnboardingMutation({ action: "complete", expectedRevision: 4, receipt }),
      /incompatible schema/,
    );
    writeInitialOnboardingState({ path, trustedDataRoot: root, status: "pending" });
    updateOnboardingState({ action: "start", expectedRevision: 0, step: "you" }, { path, trustedDataRoot: root });
    for (const [expectedRevision, step] of [[1, "model"], [2, "welcome"], [3, "context"], [4, "ready"]] as const) {
      updateOnboardingState({ action: "advance", expectedRevision, step }, { path, trustedDataRoot: root });
    }
    assert.throws(
      () => completeOnboardingState({ expectedRevision: 5, receipt: { ...receipt, knowledgeDocuments: 10_001 } }, { path, trustedDataRoot: root }),
      /receipt is invalid/,
    );
    assert.equal(readOnboardingState({ path }).status, "in-progress");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects stale completion evidence before the completed lifecycle state", () => {
  assert.throws(() => parseOnboardingState({
    schemaVersion: 1,
    flowVersion: 1,
    status: "available",
    step: "you",
    revision: 1,
    startedAt: null,
    dismissedAt: null,
    completedAt: "2026-08-15T01:00:00.000Z",
    receipt: { ...receipt, completedAt: "2026-08-15T01:00:00.000Z", localOnly: true },
    updatedAt: "2026-08-15T01:00:00.000Z",
  }), /inconsistent lifecycle/);
});

test("revision conflicts and profile paths isolate setup progress", () => {
  const first = fixture("rangabot-onboarding-one-");
  const second = fixture("rangabot-onboarding-two-");
  try {
    writeInitialOnboardingState({ path: first.path, trustedDataRoot: first.root, status: "pending" });
    writeInitialOnboardingState({ path: second.path, trustedDataRoot: second.root, status: "available" });
    updateOnboardingState({ action: "start", expectedRevision: 0, step: "you" }, { path: first.path, trustedDataRoot: first.root });
    assert.throws(
      () => updateOnboardingState({ action: "advance", expectedRevision: 0, step: "model" }, { path: first.path, trustedDataRoot: first.root }),
      (error) => error instanceof OnboardingConflictError && error.current.revision === 1,
    );
    assert.equal(readOnboardingState({ path: first.path }).status, "in-progress");
    assert.equal(readOnboardingState({ path: second.path }).status, "available");
  } finally {
    rmSync(first.root, { recursive: true, force: true });
    rmSync(second.root, { recursive: true, force: true });
  }
});

test("rejects malformed, oversized, public, and symbolic-link onboarding records", { skip: process.platform === "win32" }, () => {
  const { root, path } = fixture();
  const external = join(root, "external.json");
  try {
    writeFileSync(path, "{}\n", { mode: 0o600 });
    assert.throws(() => readOnboardingState({ path }), /incompatible schema/);
    writeFileSync(path, "x".repeat(ONBOARDING_MAX_BYTES + 1), { mode: 0o600 });
    assert.throws(() => readOnboardingState({ path }), /bounded private file/);
    writeInitialOnboardingState({ path: join(root, "private.json"), trustedDataRoot: root, status: "available" });
    chmodSync(join(root, "private.json"), 0o644);
    assert.throws(() => readOnboardingState({ path: join(root, "private.json") }), /bounded private file/);
    rmSync(path);
    writeFileSync(external, "{}\n", { mode: 0o600 });
    symlinkSync(external, path);
    assert.throws(() => readOnboardingState({ path }), /bounded private file/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
