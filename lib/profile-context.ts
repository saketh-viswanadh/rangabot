import { lstatSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { openProfileRegistry, type ProfileMetadata, type ProfileRegistrySnapshot } from "./profile-registry.ts";
import { readProfileRecoveryJournal } from "./profile-recovery.ts";
import { verificationExternalFilesystemAccess } from "./desktop-external-filesystem-policy.ts";
import { runtimeManagedDataPath, runtimePaths } from "./runtime-paths.ts";
import {
  LEGACY_PROFILE_SESSION_BINDING,
  type LocalProfileSessionBinding,
} from "./local-session-token.ts";

export type ActiveProfileContext = Readonly<{
  setupRequired: false;
  profile: ProfileMetadata;
  generation: number;
  binding: LocalProfileSessionBinding;
  profileRoot: string;
}>;

export type ProfileSetupContext = Readonly<{
  setupRequired: true;
  generation: 0;
  binding: LocalProfileSessionBinding;
  legacyRoot: string;
}>;

export type ProfileContext = ActiveProfileContext | ProfileSetupContext;

export function getProfileRegistry() {
  return openProfileRegistry({ managedRoot: runtimePaths.managedDataRoot });
}

function activeProfile(snapshot: ProfileRegistrySnapshot) {
  const profile = snapshot.profiles.find((candidate) => candidate.id === snapshot.activeProfileId);
  if (!profile) throw new Error("The active profile is missing from its registry.");
  return profile;
}

function profileCleanupRecoveryRequired() {
  const tombstonesRoot = runtimeManagedDataPath("profiles-v1", "tombstones");
  try {
    const status = lstatSync(tombstonesRoot);
    if (status.isSymbolicLink() || !status.isDirectory()
      || (process.platform !== "win32" && (status.mode & 0o077) !== 0)) {
      throw new Error("The private profile recovery area is unsafe.");
    }
    const entries = readdirSync(tombstonesRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()
        || !/^(?:reset|delete)-[0-9a-f-]{36}-[0-9a-f-]{36}$/i.test(entry.name)) {
        throw new Error("The private profile recovery area contains an unsafe entry.");
      }
    }
    return entries.length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function getProfileContext(): ProfileContext {
  const registry = getProfileRegistry();
  const inspection = registry.inspect();
  if (inspection.kind !== "ready") {
    return Object.freeze({
      setupRequired: true as const,
      generation: 0 as const,
      binding: LEGACY_PROFILE_SESSION_BINDING,
      legacyRoot: runtimePaths.managedDataRoot,
    });
  }
  if (inspection.source === "recovery") {
    throw new Error("Profile registry Recovery is required before this local workspace can be used.");
  }
  const snapshot = inspection.snapshot;
  const profile = activeProfile(snapshot);
  const expectedProfileRoot = registry.profileRoot(profile.id);
  const profileRoot = runtimePaths.dataRoot;
  if (resolve(profileRoot) !== resolve(expectedProfileRoot)) {
    throw new Error("The active profile root does not match its registry identity.");
  }
  const status = lstatSync(profileRoot);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error("The active profile root is not a safe local directory.");
  }
  if (process.platform !== "win32" && process.getuid
    && (status.uid !== process.getuid() || (status.mode & 0o077) !== 0)) {
    throw new Error("The active profile root is not owner-private.");
  }
  return Object.freeze({
    setupRequired: false as const,
    profile,
    generation: snapshot.generation,
    binding: Object.freeze({ profileId: profile.id, generation: snapshot.generation }),
    profileRoot,
  });
}

export function currentProfileSessionBinding() {
  return getProfileContext().binding;
}

function sameBinding(left: LocalProfileSessionBinding, right: LocalProfileSessionBinding) {
  return left.profileId === right.profileId && left.generation === right.generation;
}

/**
 * Return every session context that may authenticate the two recovery-only
 * endpoints. A profile mutation can durably commit generation N+1 before its
 * response reaches the renderer, so the sealed operation journal must admit
 * both the pre-operation N receipt and the validated current receipt. Normal
 * product endpoints never use this set.
 */
export function recoveryProfileSessionBindings(): readonly LocalProfileSessionBinding[] {
  const registry = getProfileRegistry();
  const inspection = registry.inspect();
  const operationRecovery = readProfileRecoveryJournal(runtimePaths.managedDataRoot);
  if (inspection.kind !== "ready") {
    return operationRecovery ? Object.freeze([LEGACY_PROFILE_SESSION_BINDING]) : Object.freeze([]);
  }
  if (inspection.source !== "recovery" && !operationRecovery) return Object.freeze([]);
  const profile = activeProfile(inspection.snapshot);
  const profileRoot = registry.profileRoot(profile.id);
  const status = lstatSync(profileRoot);
  if (status.isSymbolicLink() || !status.isDirectory()
    || (process.platform !== "win32" && process.getuid
      && (status.uid !== process.getuid() || (status.mode & 0o077) !== 0))) {
    throw new Error("The recovery profile root is not a safe owner-private directory.");
  }
  const current = Object.freeze({ profileId: profile.id, generation: inspection.snapshot.generation });
  if (!operationRecovery) return Object.freeze([current]);
  if (inspection.snapshot.generation < operationRecovery.expectedGeneration
    || inspection.snapshot.generation > operationRecovery.expectedGeneration + 1) {
    throw new Error("Profile Recovery generation evidence does not match the validated registry.");
  }
  const before = operationRecovery.operation === "default-migration"
    ? LEGACY_PROFILE_SESSION_BINDING
    : Object.freeze({ profileId: profile.id, generation: operationRecovery.expectedGeneration });
  const committed = operationRecovery.operation === "default-migration"
    ? current
    : Object.freeze({ profileId: profile.id, generation: operationRecovery.expectedGeneration + 1 });
  return Object.freeze([before, current, committed].filter(
    (candidate, index, values) => values.findIndex((other) => sameBinding(candidate, other)) === index,
  ));
}

export function recoveryProfileSessionBinding() {
  const bindings = recoveryProfileSessionBindings();
  if (bindings.length === 0) return null;
  const registry = getProfileRegistry().inspect();
  if (registry.kind !== "ready") return bindings[0] ?? null;
  return bindings.find((binding) => binding.generation === registry.snapshot.generation) ?? bindings[0] ?? null;
}

export function sessionBindingForLocalGate() {
  return recoveryProfileSessionBinding() ?? currentProfileSessionBinding();
}

export function assertProfileSessionBindingCurrent(binding: LocalProfileSessionBinding) {
  const current = currentProfileSessionBinding();
  if (current.profileId !== binding.profileId || current.generation !== binding.generation) {
    throw new Error("The active profile changed before this local operation completed.");
  }
  return current;
}

export function profileStatusDto() {
  const registry = getProfileRegistry();
  const inspection = registry.inspect();
  const operationRecovery = readProfileRecoveryJournal(runtimePaths.managedDataRoot);
  if (inspection.kind !== "ready") {
    return Object.freeze({
      schemaVersion: 1,
      setupRequired: true as const,
      generation: 0,
      activeProfileId: null,
      profiles: [] as const,
      recoveryRequired: operationRecovery !== null,
      registryRecoveryRequired: false,
      operationRecovery: operationRecovery
        ? Object.freeze({ operation: operationRecovery.operation, phase: operationRecovery.phase })
        : null,
      profileTransferAllowed: verificationExternalFilesystemAccess() === null,
      message: "Your existing RangaBot data will become the protected Default profile.",
    });
  }
  const snapshot = inspection.snapshot;
  return Object.freeze({
    schemaVersion: 1,
    setupRequired: false as const,
    generation: snapshot.generation,
    activeProfileId: snapshot.activeProfileId,
    recoveryRequired: operationRecovery !== null || profileCleanupRecoveryRequired(),
    registryRecoveryRequired: inspection.source === "recovery",
    operationRecovery: operationRecovery
      ? Object.freeze({ operation: operationRecovery.operation, phase: operationRecovery.phase })
      : null,
    profileTransferAllowed: verificationExternalFilesystemAccess() === null,
    profiles: snapshot.profiles.map((profile) => Object.freeze({
      id: profile.id,
      displayName: profile.displayName,
      kind: profile.kind,
      marker: profile.kind === "default" ? "Default" as const
        : profile.kind === "testing" ? "Testing · Temporary" as const
          : "Personal" as const,
      protected: profile.protected,
      active: profile.id === snapshot.activeProfileId,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    })),
  });
}
