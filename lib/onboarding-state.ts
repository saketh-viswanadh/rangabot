import { Buffer } from "node:buffer";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { supportsPosixPermissions, writePrivateJsonFileAtomic } from "./private-storage.ts";
import { runtimePaths } from "./runtime-paths.ts";
import {
  onboardingSteps,
  type OnboardingReceipt,
  type OnboardingSelectedModelState,
  type OnboardingState,
  type OnboardingStatus,
  type OnboardingStep,
} from "./onboarding-contract.ts";

export { onboardingSteps } from "./onboarding-contract.ts";
export type {
  OnboardingReceipt,
  OnboardingSelectedModelState,
  OnboardingState,
  OnboardingStatus,
  OnboardingStep,
} from "./onboarding-contract.ts";

export const ONBOARDING_SCHEMA_VERSION = 1 as const;
export const ONBOARDING_FLOW_VERSION = 1 as const;
export const ONBOARDING_MAX_BYTES = 4_096;

export type OnboardingMutation =
  | Readonly<{ action: "start" | "advance" | "dismiss"; expectedRevision: number; step: OnboardingStep }>
  | Readonly<{ action: "complete"; expectedRevision: number }>;

export type OnboardingCompletionReceipt = Readonly<{
  selectedModel: string;
  selectedModelState: OnboardingSelectedModelState;
  approvedWorkFolders: number;
  knowledgeDocuments: number;
}>;

function canonicalTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validCount(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 10_000;
}

function parseReceipt(value: unknown): OnboardingReceipt | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Onboarding receipt is malformed.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "approvedWorkFolders,completedAt,knowledgeDocuments,localOnly,selectedModel,selectedModelState"
    || !canonicalTimestamp(record.completedAt) || record.localOnly !== true
    || typeof record.selectedModel !== "string" || record.selectedModel.length < 1 || record.selectedModel.length > 192
    || !["installed-reviewed", "configured-unverified", "not-checked-testing"].includes(String(record.selectedModelState))
    || !validCount(record.approvedWorkFolders) || !validCount(record.knowledgeDocuments)) {
    throw new Error("Onboarding receipt is invalid.");
  }
  return Object.freeze({
    completedAt: record.completedAt,
    localOnly: true,
    selectedModel: record.selectedModel,
    selectedModelState: record.selectedModelState as OnboardingSelectedModelState,
    approvedWorkFolders: Number(record.approvedWorkFolders),
    knowledgeDocuments: Number(record.knowledgeDocuments),
  });
}

export function parseOnboardingState(value: unknown): OnboardingState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Onboarding state is malformed.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "completedAt,dismissedAt,flowVersion,receipt,revision,schemaVersion,startedAt,status,step,updatedAt"
    || record.schemaVersion !== ONBOARDING_SCHEMA_VERSION || record.flowVersion !== ONBOARDING_FLOW_VERSION
    || !["pending", "available", "in-progress", "dismissed", "completed"].includes(String(record.status))
    || !onboardingSteps.includes(record.step as OnboardingStep)
    || !Number.isSafeInteger(record.revision) || Number(record.revision) < 0
    || (record.startedAt !== null && !canonicalTimestamp(record.startedAt))
    || (record.dismissedAt !== null && !canonicalTimestamp(record.dismissedAt))
    || (record.completedAt !== null && !canonicalTimestamp(record.completedAt))
    || (record.updatedAt !== null && !canonicalTimestamp(record.updatedAt))) {
    throw new Error("Onboarding state has an incompatible schema.");
  }
  const receipt = parseReceipt(record.receipt);
  const started = record.status === "in-progress" || record.status === "dismissed" || record.status === "completed";
  if (started !== Boolean(record.startedAt)
    || (record.status === "completed") !== Boolean(record.completedAt && receipt)
    || (record.status !== "completed" && (record.completedAt !== null || receipt !== null))
    || (receipt && receipt.completedAt !== record.completedAt)
    || (record.status === "dismissed") !== Boolean(record.dismissedAt)
    || (record.status === "in-progress" && !record.startedAt)) {
    throw new Error("Onboarding state has an inconsistent lifecycle.");
  }
  return Object.freeze({
    schemaVersion: ONBOARDING_SCHEMA_VERSION,
    flowVersion: ONBOARDING_FLOW_VERSION,
    status: record.status as OnboardingStatus,
    step: record.step as OnboardingStep,
    revision: Number(record.revision),
    startedAt: record.startedAt as string | null,
    dismissedAt: record.dismissedAt as string | null,
    completedAt: record.completedAt as string | null,
    receipt,
    updatedAt: record.updatedAt as string | null,
  });
}

function initialState(status: "pending" | "available"): OnboardingState {
  return Object.freeze({
    schemaVersion: ONBOARDING_SCHEMA_VERSION,
    flowVersion: ONBOARDING_FLOW_VERSION,
    status,
    step: "you",
    revision: 0,
    startedAt: null,
    dismissedAt: null,
    completedAt: null,
    receipt: null,
    updatedAt: null,
  });
}

export function writeInitialOnboardingState(input: {
  path: string;
  trustedDataRoot: string;
  status: "pending" | "available";
}) {
  try {
    lstatSync(input.path);
    return readOnboardingState({ path: input.path, initialStatus: input.status });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const state = initialState(input.status);
  writePrivateJsonFileAtomic(input.path, state, { trustedRoot: input.trustedDataRoot });
  return state;
}

export function readOnboardingState(options: { path?: string; initialStatus?: "pending" | "available" } = {}) {
  const path = options.path ?? runtimePaths.onboardingState;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (supportsPosixPermissions() ? constants.O_NOFOLLOW : 0));
    const opened = fstatSync(descriptor);
    const status = lstatSync(path);
    if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1 || !opened.isFile() || opened.nlink !== 1
      || status.dev !== opened.dev || status.ino !== opened.ino || opened.size > ONBOARDING_MAX_BYTES
      || (supportsPosixPermissions() && (opened.mode & 0o077) !== 0)) {
      throw new Error("Onboarding state is not a bounded private file.");
    }
    return parseOnboardingState(JSON.parse(readFileSync(descriptor, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return initialState(options.initialStatus ?? "available");
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error("Onboarding state is not a bounded private file.");
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export class OnboardingConflictError extends Error {
  readonly current: OnboardingState;
  constructor(current: OnboardingState) {
    super("Setup progress changed in another local window.");
    this.name = "OnboardingConflictError";
    this.current = current;
  }
}

function validateMutation(input: OnboardingMutation) {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error("A valid setup revision is required.");
  if (input.action === "complete") return;
  if (!onboardingSteps.includes(input.step)) throw new Error("A valid setup step is required.");
}

function adjacentStep(left: OnboardingStep, right: OnboardingStep) {
  return Math.abs(onboardingSteps.indexOf(left) - onboardingSteps.indexOf(right)) === 1;
}

function assertLifecycleTransition(current: OnboardingState, input: Exclude<OnboardingMutation, { action: "complete" }>) {
  if (input.action === "start") {
    if (!["pending", "available", "dismissed"].includes(current.status) || input.step !== current.step) {
      throw new Error("Setup can only start or resume from its saved step.");
    }
    return;
  }
  if (input.action === "advance") {
    if (current.status !== "in-progress" || !adjacentStep(current.step, input.step)) {
      throw new Error("Setup navigation must move one saved step at a time.");
    }
    return;
  }
  if (!["pending", "available", "in-progress"].includes(current.status) || input.step !== current.step) {
    throw new Error("Only an active setup invitation or saved step can be dismissed.");
  }
}

export function updateOnboardingState(
  input: OnboardingMutation,
  options: { path?: string; trustedDataRoot?: string; initialStatus?: "pending" | "available"; now?: string } = {},
) {
  validateMutation(input);
  const now = options.now ?? new Date().toISOString();
  if (!canonicalTimestamp(now)) throw new Error("A valid setup update time is required.");
  const current = readOnboardingState({ path: options.path, initialStatus: options.initialStatus });
  if (current.revision !== input.expectedRevision) throw new OnboardingConflictError(current);
  if (current.status === "completed") throw new Error("Completed setup is replayed without changing its durable receipt.");

  if (input.action === "complete") throw new Error("Setup completion requires a server-derived current-state receipt.");
  assertLifecycleTransition(current, input);
  const next: OnboardingState = Object.freeze({
    ...current,
    status: input.action === "dismiss" ? "dismissed" as const : "in-progress" as const,
    step: input.step,
    revision: current.revision + 1,
    startedAt: current.startedAt ?? now,
    dismissedAt: input.action === "dismiss" ? now : null,
    completedAt: null,
    receipt: null,
    updatedAt: now,
  });
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > ONBOARDING_MAX_BYTES) throw new Error("Onboarding state exceeds the private file limit.");
  writePrivateJsonFileAtomic(options.path ?? runtimePaths.onboardingState, next, {
    trustedRoot: options.trustedDataRoot ?? runtimePaths.dataRoot,
  });
  return next;
}

export function completeOnboardingState(
  input: Readonly<{ expectedRevision: number; receipt: OnboardingCompletionReceipt }>,
  options: { path?: string; trustedDataRoot?: string; initialStatus?: "pending" | "available"; now?: string } = {},
) {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error("A valid setup revision is required.");
  const now = options.now ?? new Date().toISOString();
  if (!canonicalTimestamp(now)) throw new Error("A valid setup update time is required.");
  const receipt = parseReceipt({ ...input.receipt, completedAt: now, localOnly: true });
  if (!receipt) throw new Error("A current-state setup receipt is required.");
  const current = readOnboardingState({ path: options.path, initialStatus: options.initialStatus });
  if (current.revision !== input.expectedRevision) throw new OnboardingConflictError(current);
  if (current.status === "completed") throw new Error("Completed setup is replayed without changing its durable receipt.");
  if (current.status !== "in-progress" || current.step !== "ready") {
    throw new Error("Setup can only be completed from its saved Ready step.");
  }
  const next: OnboardingState = Object.freeze({
    ...current,
    status: "completed" as const,
    step: "ready" as const,
    revision: current.revision + 1,
    startedAt: current.startedAt ?? now,
    dismissedAt: null,
    completedAt: now,
    receipt,
    updatedAt: now,
  });
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > ONBOARDING_MAX_BYTES) throw new Error("Onboarding state exceeds the private file limit.");
  writePrivateJsonFileAtomic(options.path ?? runtimePaths.onboardingState, next, {
    trustedRoot: options.trustedDataRoot ?? runtimePaths.dataRoot,
  });
  return next;
}

export function parseOnboardingMutation(value: unknown): OnboardingMutation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A setup progress object is required.");
  const record = value as Record<string, unknown>;
  if (record.action === "complete") {
    if (Object.keys(record).sort().join(",") !== "action,expectedRevision") {
      throw new Error("Setup completion has an incompatible schema.");
    }
    const mutation = { action: "complete" as const, expectedRevision: Number(record.expectedRevision) };
    validateMutation(mutation);
    return mutation;
  }
  if ((record.action !== "start" && record.action !== "advance" && record.action !== "dismiss")
    || Object.keys(record).sort().join(",") !== "action,expectedRevision,step") {
    throw new Error("Setup progress has an incompatible schema.");
  }
  const mutation: Extract<OnboardingMutation, { action: "start" | "advance" | "dismiss" }> = {
    action: record.action,
    expectedRevision: Number(record.expectedRevision),
    step: record.step as OnboardingStep,
  };
  validateMutation(mutation);
  return mutation;
}
