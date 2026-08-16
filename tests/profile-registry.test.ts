import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_PROFILE_DISPLAY_NAME,
  openProfileRegistry,
  PROFILE_REGISTRY_DIRECTORY_NAME,
  ProfileRegistryError,
  type ProfileRegistryOwnerIdentity,
  type ProfileRegistryOwnerState,
} from "../lib/profile-registry.ts";

const defaultId = "10000000-0000-4000-8000-000000000001";
const secondId = "20000000-0000-4000-8000-000000000002";
const thirdId = "30000000-0000-4000-8000-000000000003";

function fixture(options: {
  inspectOwner?: (owner: ProfileRegistryOwnerIdentity) => ProfileRegistryOwnerState;
  onLockClaimForTests?: (claim: Readonly<{
    lockFile: string;
    claimFile: string;
    expectedToken: string;
  }>) => void;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "rangabot-profile-registry-"));
  let time = Date.parse("2026-08-13T00:00:00.000Z");
  let token = 0;
  const ids = [defaultId, secondId, thirdId];
  const registry = openProfileRegistry({
    managedRoot: root,
    ownerIdentity: { pid: 41001, startIdentity: "synthetic-owner-start" },
    inspectOwner: options.inspectOwner,
    onLockClaimForTests: options.onLockClaimForTests,
    now: () => new Date(time += 1_000),
    uuid: () => ids.shift() ?? "40000000-0000-4000-8000-000000000004",
    lockToken: () => `${String(token += 1).padStart(2, "0")}${"a".repeat(41)}`,
  });
  return { root, registry };
}

function errorWithCode(code: string) {
  return (error: unknown) => error instanceof ProfileRegistryError && error.code === code;
}

function ownerPermissions(path: string) {
  return lstatSync(path).mode & 0o777;
}

function validLock(owner: ProfileRegistryOwnerIdentity) {
  return {
    schemaVersion: 1,
    owner,
    token: "z".repeat(43),
    acquiredAt: "2026-08-13T00:00:00.000Z",
  };
}

test("inspection and opening are read-only until explicit Default initialization", () => {
  const { root, registry } = fixture();
  try {
    assert.deepEqual(registry.inspect(), { kind: "setup-required" });
    assert.equal(registry.read(), null);
    assert.deepEqual(readdirSync(root), []);

    assert.throws(() => registry.initializeDefault({ displayName: "unsafe/name" }), errorWithCode("precondition"));
    assert.deepEqual(readdirSync(root), []);

    const initialized = registry.initializeDefault({ profileId: defaultId });
    assert.equal(initialized.generation, 1);
    assert.equal(initialized.activeProfileId, defaultId);
    assert.deepEqual(initialized.profiles, [{
      id: defaultId,
      displayName: DEFAULT_PROFILE_DISPLAY_NAME,
      kind: "default",
      protected: true,
      createdAt: initialized.profiles[0]!.createdAt,
      updatedAt: initialized.profiles[0]!.updatedAt,
    }]);
    assert.equal(existsSync(registry.layout.profilesRoot), false, "metadata setup must not create a profile data root");
    assert.deepEqual(readdirSync(root), [PROFILE_REGISTRY_DIRECTORY_NAME]);
    assert.deepEqual(readdirSync(registry.layout.registryRoot), ["registry.json"]);
    assert.equal(registry.read()?.generation, 1);
    assert.throws(() => registry.initializeDefault(), errorWithCode("already-initialized"));

    if (process.platform !== "win32") {
      assert.equal(ownerPermissions(registry.layout.registryRoot), 0o700);
      assert.equal(ownerPermissions(registry.layout.registryFile), 0o600);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("create, rename, switch, and remove enforce generation and protected-profile preconditions", () => {
  const { root, registry } = fixture();
  try {
    const initial = registry.initializeDefault({ profileId: defaultId });
    const created = registry.create({
      profileId: secondId,
      displayName: "School Work",
      kind: "personal",
      expectedGeneration: initial.generation,
    });
    assert.equal(created.generation, 2);
    assert.equal(created.activeProfileId, defaultId);
    assert.deepEqual(created.profiles.map(({ id, displayName, kind, protected: protectedProfile }) => ({
      id, displayName, kind, protected: protectedProfile,
    })), [
      { id: defaultId, displayName: "Default", kind: "default", protected: true },
      { id: secondId, displayName: "School Work", kind: "personal", protected: false },
    ]);
    assert.equal(existsSync(registry.profileRoot(secondId)), false, "registry mutations only commit metadata");

    assert.throws(() => registry.create({
      profileId: thirdId,
      displayName: "school work",
      kind: "testing",
      expectedGeneration: created.generation,
    }), errorWithCode("duplicate-name"));
    const renamedDefault = registry.rename({
      profileId: defaultId,
      displayName: "Primary",
      expectedGeneration: created.generation,
    });
    assert.equal(renamedDefault.profiles[0]?.displayName, "Primary");
    assert.equal(renamedDefault.profiles[0]?.kind, "default", "renaming cannot change the protected identity marker");
    assert.throws(() => registry.remove({
      profileId: defaultId,
      expectedGeneration: renamedDefault.generation,
    }), errorWithCode("protected"));

    const renamed = registry.rename({
      profileId: secondId,
      displayName: "Research",
      expectedGeneration: renamedDefault.generation,
    });
    assert.equal(renamed.generation, 4);
    assert.equal(renamed.profiles[1]?.displayName, "Research");
    assert.throws(() => registry.switchActive({
      profileId: secondId,
      expectedGeneration: created.generation,
    }), errorWithCode("conflict"));

    const switched = registry.switchActive({
      profileId: secondId,
      expectedGeneration: renamed.generation,
    });
    assert.equal(switched.generation, 5);
    assert.equal(switched.activeProfileId, secondId);
    assert.throws(() => registry.remove({
      profileId: secondId,
      expectedGeneration: switched.generation,
    }), errorWithCode("precondition"));

    const switchedBack = registry.switchActive({
      profileId: defaultId,
      expectedGeneration: switched.generation,
    });
    const removed = registry.remove({
      profileId: secondId,
      expectedGeneration: switchedBack.generation,
    });
    assert.equal(removed.generation, 7);
    assert.deepEqual(removed.profiles.map((profile) => profile.id), [defaultId]);
    const bumped = registry.bump({ expectedGeneration: removed.generation });
    assert.equal(bumped.generation, 8, "reset callers can invalidate stale sessions without changing the active ID");
    assert.equal(bumped.activeProfileId, removed.activeProfileId);
    assert.deepEqual(bumped.profiles, removed.profiles);
    assert.deepEqual(registry.read(), bumped);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("display names and IDs stay canonical, bounded, unique, and path-opaque", () => {
  const { root, registry } = fixture();
  try {
    registry.initializeDefault({ profileId: defaultId });
    for (const displayName of [
      "", " Leading", "Trailing ", "Two  Spaces", ".", "..", "a/b", "a\\b", "line\nfeed",
      "e\u0301", "x".repeat(65), "Default", "default",
    ]) {
      assert.throws(() => registry.create({
        profileId: secondId,
        displayName,
        kind: "personal",
        expectedGeneration: 1,
      }), (error: unknown) => error instanceof ProfileRegistryError);
    }
    for (const profileId of [
      "default", "../escape", "abcdefab-cdef-4abc-8def-abcdefabcdef".toUpperCase(),
      "00000000-0000-0000-0000-000000000000",
    ]) {
      assert.throws(() => registry.profileRoot(profileId), errorWithCode("precondition"));
    }
    assert.equal(registry.profileRoot(secondId), join(root, "profiles-v1", "data", secondId));
    assert.equal(registry.read()?.generation, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("atomic generations retain a recovery copy and explicit recovery repairs a damaged primary", () => {
  const { root, registry } = fixture();
  try {
    registry.initializeDefault({ profileId: defaultId });
    const created = registry.create({
      profileId: secondId, displayName: "Work", kind: "personal", expectedGeneration: 1,
    });
    const renamed = registry.rename({ profileId: secondId, displayName: "Projects", expectedGeneration: 2 });
    assert.equal(created.generation, 2);
    assert.equal(renamed.generation, 3);
    assert.equal(JSON.parse(readFileSync(registry.layout.recoveryFile, "utf8")).generation, 2);

    writeFileSync(registry.layout.registryFile, "{interrupted", { mode: 0o600 });
    const fallback = registry.inspect();
    assert.equal(fallback.kind, "ready");
    assert.equal(fallback.kind === "ready" ? fallback.source : undefined, "recovery");
    assert.equal(fallback.kind === "ready" ? fallback.snapshot.generation : undefined, 2);

    const recovered = registry.recover({ expectedGeneration: 2 });
    assert.equal(recovered.generation, 2);
    assert.equal(registry.inspect().kind, "ready");
    assert.equal(JSON.parse(readFileSync(registry.layout.registryFile, "utf8")).generation, 2);
    assert.equal(readdirSync(registry.layout.registryRoot).some((name) => name.endsWith(".tmp")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a newer valid recovery generation wins without mutating during inspection", () => {
  const { root, registry } = fixture();
  try {
    registry.initializeDefault({ profileId: defaultId });
    registry.create({ profileId: secondId, displayName: "Work", kind: "personal", expectedGeneration: 1 });
    const generationTwo = readFileSync(registry.layout.registryFile, "utf8");
    registry.rename({ profileId: secondId, displayName: "Projects", expectedGeneration: 2 });
    writeFileSync(registry.layout.recoveryFile, readFileSync(registry.layout.registryFile), { mode: 0o600 });
    writeFileSync(registry.layout.registryFile, generationTwo, { mode: 0o600 });
    const before = readFileSync(registry.layout.registryFile, "utf8");
    const inspection = registry.inspect();
    assert.equal(inspection.kind, "ready");
    assert.equal(inspection.kind === "ready" ? inspection.source : undefined, "recovery");
    assert.equal(inspection.kind === "ready" ? inspection.snapshot.generation : undefined, 3);
    assert.equal(readFileSync(registry.layout.registryFile, "utf8"), before, "inspection must not repair on disk");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readGeneration returns an exact validated primary or recovery snapshot without selecting the newest", () => {
  const { root, registry } = fixture();
  try {
    const generationOne = registry.initializeDefault({ profileId: defaultId });
    const generationTwo = registry.create({
      profileId: secondId,
      displayName: "Work",
      kind: "personal",
      expectedGeneration: generationOne.generation,
    });

    assert.deepEqual(registry.readGeneration(1), generationOne);
    assert.deepEqual(registry.readGeneration(2), generationTwo);
    assert.equal(registry.readGeneration(3), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readGeneration rejects conflicting valid copies at the same generation", () => {
  const { root, registry } = fixture();
  try {
    registry.initializeDefault({ profileId: defaultId });
    const generationTwo = registry.create({
      profileId: secondId,
      displayName: "Work",
      kind: "personal",
      expectedGeneration: 1,
    });
    const conflicting = {
      ...generationTwo,
      profiles: generationTwo.profiles.map((profile) => (
        profile.id === secondId ? { ...profile, displayName: "Different" } : profile
      )),
    };
    writeFileSync(registry.layout.recoveryFile, `${JSON.stringify(conflicting, null, 2)}\n`, { mode: 0o600 });

    assert.throws(() => registry.readGeneration(2), errorWithCode("invalid"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live owner/start locks block mutations and dead owners are recovered conservatively", () => {
  let ownerState: ProfileRegistryOwnerState = "same-start";
  let observedOwner: ProfileRegistryOwnerIdentity | undefined;
  const { root, registry } = fixture({
    inspectOwner(owner) {
      observedOwner = owner;
      return ownerState;
    },
  });
  try {
    registry.initializeDefault({ profileId: defaultId });
    const lockOwner = { pid: 51001, startIdentity: "other-process-start" };
    writeFileSync(registry.layout.lockFile, `${JSON.stringify(validLock(lockOwner))}\n`, { mode: 0o600 });
    const lockBytes = readFileSync(registry.layout.lockFile, "utf8");
    assert.throws(() => registry.create({
      profileId: secondId,
      displayName: "Work",
      kind: "personal",
      expectedGeneration: 1,
    }), errorWithCode("active-lock"));
    assert.deepEqual(observedOwner, lockOwner);
    assert.equal(readFileSync(registry.layout.lockFile, "utf8"), lockBytes);
    assert.equal(registry.read()?.generation, 1);

    ownerState = "dead";
    const created = registry.create({
      profileId: secondId,
      displayName: "Work",
      kind: "personal",
      expectedGeneration: 1,
    });
    assert.equal(created.generation, 2);
    assert.equal(existsSync(registry.layout.lockFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed locks are never guessed stale or removed", () => {
  const { root, registry } = fixture({ inspectOwner: () => "dead" });
  try {
    registry.initializeDefault({ profileId: defaultId });
    writeFileSync(registry.layout.lockFile, "{}\n", { mode: 0o600 });
    assert.throws(() => registry.create({
      profileId: secondId,
      displayName: "Work",
      kind: "testing",
      expectedGeneration: 1,
    }), errorWithCode("unsafe-storage"));
    assert.equal(readFileSync(registry.layout.lockFile, "utf8"), "{}\n");
    assert.equal(registry.read()?.generation, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale-lock reclamation never unlinks a replacement published after inspection", () => {
  const staleOwner = { pid: 51002, startIdentity: "stale-process-start" };
  const replacementOwner = { pid: 51003, startIdentity: "replacement-process-start" };
  const stale = validLock(staleOwner);
  const replacement = validLock(replacementOwner);
  let injected = false;
  const { root, registry } = fixture({
    inspectOwner(owner) {
      return owner.startIdentity === staleOwner.startIdentity ? "dead" : "same-start";
    },
    onLockClaimForTests({ lockFile, expectedToken }) {
      if (injected || expectedToken !== stale.token) return;
      injected = true;
      unlinkSync(lockFile);
      writeFileSync(lockFile, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
    },
  });
  try {
    registry.initializeDefault({ profileId: defaultId });
    writeFileSync(registry.layout.lockFile, `${JSON.stringify(stale)}\n`, { mode: 0o600 });

    assert.throws(() => registry.create({
      profileId: secondId,
      displayName: "Work",
      kind: "personal",
      expectedGeneration: 1,
    }), errorWithCode("active-lock"));

    assert.equal(injected, true);
    assert.equal(readFileSync(registry.layout.lockFile, "utf8"), `${JSON.stringify(replacement)}\n`);
    assert.equal(registry.read()?.generation, 1);
    assert.deepEqual(
      readdirSync(registry.layout.registryRoot).filter((name) => name.startsWith(".lock-claim-")),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("competing stale-lock claims are normalized before one bounded reclaimer proceeds", () => {
  const staleOwner = { pid: 51005, startIdentity: "contended-stale-start" };
  const stale = validLock(staleOwner);
  let competingClaim = "";
  const { root, registry } = fixture({
    inspectOwner: () => "dead",
    onLockClaimForTests({ lockFile, expectedToken }) {
      if (competingClaim || expectedToken !== stale.token) return;
      competingClaim = join(root, PROFILE_REGISTRY_DIRECTORY_NAME, `.lock-claim-${"c".repeat(48)}.tmp`);
      linkSync(lockFile, competingClaim);
    },
  });
  try {
    registry.initializeDefault({ profileId: defaultId });
    writeFileSync(registry.layout.lockFile, `${JSON.stringify(stale)}\n`, { mode: 0o600 });

    const created = registry.create({
      profileId: secondId,
      displayName: "Work",
      kind: "personal",
      expectedGeneration: 1,
    });

    assert.equal(created.generation, 2);
    assert.equal(existsSync(registry.layout.lockFile), false);
    assert.equal(existsSync(competingClaim), false);
    assert.deepEqual(
      readdirSync(registry.layout.registryRoot).filter((name) => name.startsWith(".lock-claim-")),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a crashed stale-lock claim is recovered without leaving linked lock state", () => {
  const staleOwner = { pid: 51006, startIdentity: "crashed-stale-start" };
  const stale = validLock(staleOwner);
  const { root, registry } = fixture({ inspectOwner: () => "dead" });
  try {
    registry.initializeDefault({ profileId: defaultId });
    writeFileSync(registry.layout.lockFile, `${JSON.stringify(stale)}\n`, { mode: 0o600 });
    const crashedClaim = join(
      registry.layout.registryRoot,
      `.lock-claim-${"d".repeat(48)}.tmp`,
    );
    linkSync(registry.layout.lockFile, crashedClaim);

    const created = registry.create({
      profileId: secondId,
      displayName: "Work",
      kind: "personal",
      expectedGeneration: 1,
    });

    assert.equal(created.generation, 2);
    assert.equal(existsSync(registry.layout.lockFile), false);
    assert.equal(existsSync(crashedClaim), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a detached crashed claim is removed before a new lock is published", () => {
  const staleOwner = { pid: 51007, startIdentity: "detached-stale-start" };
  const stale = validLock(staleOwner);
  const { root, registry } = fixture();
  try {
    registry.initializeDefault({ profileId: defaultId });
    writeFileSync(registry.layout.lockFile, `${JSON.stringify(stale)}\n`, { mode: 0o600 });
    const detachedClaim = join(
      registry.layout.registryRoot,
      `.lock-claim-${"e".repeat(48)}.tmp`,
    );
    linkSync(registry.layout.lockFile, detachedClaim);
    unlinkSync(registry.layout.lockFile);

    const created = registry.create({
      profileId: secondId,
      displayName: "Work",
      kind: "personal",
      expectedGeneration: 1,
    });

    assert.equal(created.generation, 2);
    assert.equal(existsSync(detachedClaim), false);
    assert.equal(existsSync(registry.layout.lockFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unrecognized lock hardlinks remain fail-closed and untouched", () => {
  const outer = mkdtempSync(join(tmpdir(), "rangabot-profile-lock-hardlink-"));
  const root = join(outer, "managed");
  const external = join(outer, "external-lock");
  const staleOwner = { pid: 51008, startIdentity: "externally-linked-stale-start" };
  const stale = validLock(staleOwner);
  try {
    mkdirPrivate(root);
    const registry = openProfileRegistry({ managedRoot: root, inspectOwner: () => "dead" });
    registry.initializeDefault({ profileId: defaultId });
    writeFileSync(registry.layout.lockFile, `${JSON.stringify(stale)}\n`, { mode: 0o600 });
    linkSync(registry.layout.lockFile, external);

    assert.throws(() => registry.create({
      profileId: secondId,
      displayName: "Work",
      kind: "personal",
      expectedGeneration: 1,
    }), errorWithCode("unsafe-storage"));
    assert.equal(readFileSync(external, "utf8"), `${JSON.stringify(stale)}\n`);
    assert.equal(readFileSync(registry.layout.lockFile, "utf8"), `${JSON.stringify(stale)}\n`);
    assert.equal(registry.read()?.generation, 1);
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test("release never unlinks a replacement lock after a committed mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-profile-release-race-"));
  const mutatingOwner = { pid: 41005, startIdentity: "mutating-release-owner" };
  const replacement = {
    ...validLock(mutatingOwner),
    token: "r".repeat(43),
    acquiredAt: "2026-08-13T01:00:01.000Z",
  };
  try {
    const initial = openProfileRegistry({ managedRoot: root });
    initial.initializeDefault({ profileId: defaultId });

    let injected = false;
    const registry = openProfileRegistry({
      managedRoot: root,
      ownerIdentity: mutatingOwner,
      now: () => new Date("2026-08-13T01:00:00.000Z"),
      lockToken: () => "r".repeat(43),
      onLockClaimForTests({ lockFile, expectedToken }) {
        if (injected || expectedToken !== "r".repeat(43)) return;
        injected = true;
        unlinkSync(lockFile);
        writeFileSync(lockFile, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
      },
    });

    const created = registry.create({
      profileId: secondId,
      displayName: "Work",
      kind: "personal",
      expectedGeneration: 1,
    });

    assert.equal(created.generation, 2, "the durably committed mutation remains the returned result");
    assert.equal(registry.read()?.generation, 2);
    assert.equal(readFileSync(registry.layout.lockFile, "utf8"), `${JSON.stringify(replacement)}\n`);
    assert.deepEqual(
      readdirSync(registry.layout.registryRoot).filter((name) => name.startsWith(".lock-claim-")),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("symbolic links, hard links, and public registry state are rejected without external writes", {
  skip: process.platform === "win32",
}, () => {
  const outer = mkdtempSync(join(tmpdir(), "rangabot-profile-boundaries-"));
  const root = join(outer, "managed");
  const external = join(outer, "external");
  try {
    mkdirPrivate(root);
    mkdirPrivate(external);
    const registry = openProfileRegistry({ managedRoot: root });
    registry.initializeDefault({ profileId: defaultId });
    const externalFile = join(external, "outside.json");
    writeFileSync(externalFile, "outside\n", { mode: 0o600 });

    rmSync(registry.layout.registryFile);
    symlinkSync(externalFile, registry.layout.registryFile);
    assert.throws(() => registry.read(), errorWithCode("unsafe-storage"));
    assert.equal(readFileSync(externalFile, "utf8"), "outside\n");

    rmSync(registry.layout.registryFile);
    writeFileSync(registry.layout.registryFile, "{}\n", { mode: 0o600 });
    const otherLink = join(external, "registry-hardlink.json");
    linkSync(registry.layout.registryFile, otherLink);
    assert.throws(() => registry.read(), errorWithCode("unsafe-storage"));
    assert.equal(readFileSync(otherLink, "utf8"), "{}\n");

    rmSync(otherLink);
    writeFileSync(registry.layout.registryFile, JSON.stringify({}), { mode: 0o644 });
    chmodSync(registry.layout.registryFile, 0o644);
    assert.throws(() => registry.read(), errorWithCode("unsafe-storage"));
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test("managed-root and registry-directory symlinks are refused", { skip: process.platform === "win32" }, () => {
  const outer = mkdtempSync(join(tmpdir(), "rangabot-profile-root-links-"));
  const external = join(outer, "external");
  const rootAlias = join(outer, "root-alias");
  const managed = join(outer, "managed");
  try {
    mkdirPrivate(external);
    symlinkSync(external, rootAlias);
    const aliased = openProfileRegistry({ managedRoot: rootAlias });
    assert.throws(() => aliased.read(), errorWithCode("unsafe-storage"));
    assert.throws(() => aliased.initializeDefault({ profileId: defaultId }), errorWithCode("unsafe-storage"));
    assert.deepEqual(readdirSync(external), []);

    mkdirPrivate(managed);
    symlinkSync(external, join(managed, PROFILE_REGISTRY_DIRECTORY_NAME));
    const linkedRegistry = openProfileRegistry({ managedRoot: managed });
    assert.throws(() => linkedRegistry.read(), errorWithCode("unsafe-storage"));
    assert.throws(() => linkedRegistry.initializeDefault({ profileId: defaultId }), errorWithCode("unsafe-storage"));
    assert.deepEqual(readdirSync(external), []);
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test("registry mutations remain valid when the wall clock moves backwards", () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-profile-clock-rollback-"));
  let timestamp = "2026-08-13T12:00:00.000Z";
  try {
    const registry = openProfileRegistry({
      managedRoot: root,
      ownerIdentity: { pid: 41002, startIdentity: "synthetic-clock-owner" },
      inspectOwner: () => "same-start",
      now: () => new Date(timestamp),
      uuid: (() => {
        const ids = [defaultId, secondId];
        return () => ids.shift() ?? thirdId;
      })(),
    });
    registry.initializeDefault();
    timestamp = "2025-08-13T12:00:00.000Z";

    const created = registry.create({
      displayName: "Synthetic",
      kind: "testing",
      expectedGeneration: 1,
    });

    assert.equal(created.generation, 2);
    assert.equal(created.updatedAt, "2026-08-13T12:00:00.000Z");
    assert.equal(created.profiles[1]?.createdAt, "2026-08-13T12:00:00.000Z");
    assert.deepEqual(registry.inspect(), { kind: "ready", snapshot: created, source: "primary" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function mkdirPrivate(path: string) {
  mkdirSync(path, { mode: 0o700 });
}
