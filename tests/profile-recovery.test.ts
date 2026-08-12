import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createProfileBackup } from "../lib/profile-backup.ts";
import { inventoryLegacyProfileData } from "../lib/profile-migration.ts";
import {
  clearProfileRecovery,
  createProfileRecoveryJournalForTests,
  updateProfileRecovery,
} from "../lib/profile-recovery.ts";

const defaultId = "10000000-0000-4000-8000-000000000001";
const personalId = "20000000-0000-4000-8000-000000000002";
const testingId = "30000000-0000-4000-8000-000000000003";
const operationId = "40000000-0000-4000-8000-000000000004";

function moduleUrl(path: string) {
  return pathToFileURL(resolve(path)).href;
}

function fixture(name: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `rangabot-profile-recovery-${name}-`)));
  chmodSync(root, 0o700);
  const managedRoot = join(root, "managed");
  mkdirSync(managedRoot, { mode: 0o700 });
  return { root, managedRoot };
}

function runScenario(managedRoot: string, source: string) {
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", source], {
    cwd: managedRoot,
    env: {
      ...process.env,
      RANGABOT_RESOURCE_ROOT: realpathSync(resolve(".")),
      RANGABOT_DATA_ROOT: managedRoot,
      KNOWLEDGE_DISABLE_EMBEDDINGS: "1",
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  return JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "null") as Record<string, unknown>;
}

test("interrupted empty creation is discarded and all other mutations remain blocked until explicit Recovery", () => {
  const { managedRoot } = fixture("create");
  const result = runScenario(managedRoot, String.raw`
    import assert from "node:assert/strict";
    import { mkdirSync, existsSync } from "node:fs";
    const lifecycle = await import(${JSON.stringify(moduleUrl("lib/profile-lifecycle.ts"))});
    const context = await import(${JSON.stringify(moduleUrl("lib/profile-context.ts"))});
    const recovery = await import(${JSON.stringify(moduleUrl("lib/profile-recovery.ts"))});
    const registry = context.getProfileRegistry();
    registry.initializeDefault({ profileId: ${JSON.stringify(defaultId)} });
    mkdirSync(registry.layout.profilesRoot, { recursive: true, mode: 0o700 });
    mkdirSync(registry.profileRoot(${JSON.stringify(defaultId)}), { mode: 0o700 });
    recovery.createProfileRecoveryJournalForTests({
      managedRoot: ${JSON.stringify(managedRoot)}, operation: "create", profileId: ${JSON.stringify(personalId)},
      expectedGeneration: 1, operationId: ${JSON.stringify(operationId)}, now: "2026-08-13T00:00:00.000Z",
    });
    mkdirSync(registry.profileRoot(${JSON.stringify(personalId)}), { mode: 0o700 });
    recovery.updateProfileRecovery(${JSON.stringify(managedRoot)}, "profile-root-created");
    assert.throws(() => lifecycle.renameProfile({ profileId: ${JSON.stringify(defaultId)}, displayName: "Home", expectedGeneration: 1 }), /Recovery is required/);
    const repaired = lifecycle.recoverProfileLifecycle({ confirmed: true, expectedGeneration: 1 });
    assert.equal(repaired.resolution, "rolled-back");
    console.log(JSON.stringify({ removed: !existsSync(registry.profileRoot(${JSON.stringify(personalId)})), journal: recovery.readProfileRecoveryJournal(${JSON.stringify(managedRoot)}) }));
  `);
  assert.deepEqual(result, { removed: true, journal: null });
});

test("Recovery accepts the sealed pre-operation and committed session receipts only", () => {
  const { managedRoot } = fixture("session-generation");
  const result = runScenario(managedRoot, String.raw`
    import { mkdirSync } from "node:fs";
    const context = await import(${JSON.stringify(moduleUrl("lib/profile-context.ts"))});
    const requestBinding = await import(${JSON.stringify(moduleUrl("lib/profile-request.ts"))});
    const recovery = await import(${JSON.stringify(moduleUrl("lib/profile-recovery.ts"))});
    const registry = context.getProfileRegistry();
    registry.initializeDefault({ profileId: ${JSON.stringify(defaultId)} });
    mkdirSync(registry.layout.profilesRoot, { recursive: true, mode: 0o700 });
    mkdirSync(registry.profileRoot(${JSON.stringify(defaultId)}), { mode: 0o700 });
    recovery.createProfileRecoveryJournalForTests({
      managedRoot: ${JSON.stringify(managedRoot)}, operation: "create", profileId: ${JSON.stringify(personalId)},
      expectedGeneration: 1, operationId: ${JSON.stringify(operationId)}, now: "2026-08-13T00:00:00.000Z",
    });
    mkdirSync(registry.profileRoot(${JSON.stringify(personalId)}), { mode: 0o700 });
    recovery.updateProfileRecovery(${JSON.stringify(managedRoot)}, "profile-root-created");
    registry.create({ profileId: ${JSON.stringify(personalId)}, displayName: "Work", kind: "personal", expectedGeneration: 1 });
    recovery.updateProfileRecovery(${JSON.stringify(managedRoot)}, "registry-committed");
    const bindings = context.recoveryProfileSessionBindings();
    const accept = (value) => {
      try {
        return requestBinding.recoveryProfileBindingFromRequest(new Request("http://127.0.0.1/api/profiles/recover", {
          headers: { "X-Rangabot-Profile-Context": value },
        })).generation;
      } catch { return null; }
    };
    console.log(JSON.stringify({ bindings, before: accept(${JSON.stringify(defaultId)} + ":1"), committed: accept(${JSON.stringify(defaultId)} + ":2"), unrelated: accept(${JSON.stringify(personalId)} + ":2") }));
  `);
  assert.deepEqual(result, {
    bindings: [
      { profileId: defaultId, generation: 1 },
      { profileId: defaultId, generation: 2 },
    ],
    before: 1,
    committed: 2,
    unrelated: null,
  });
});

test("Recovery refuses to discard a non-empty or linked create orphan", () => {
  for (const kind of ["non-empty", "symlink"] as const) {
    const { managedRoot } = fixture(kind);
    const result = runScenario(managedRoot, String.raw`
      import assert from "node:assert/strict";
      import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
      const lifecycle = await import(${JSON.stringify(moduleUrl("lib/profile-lifecycle.ts"))});
      const context = await import(${JSON.stringify(moduleUrl("lib/profile-context.ts"))});
      const recovery = await import(${JSON.stringify(moduleUrl("lib/profile-recovery.ts"))});
      const registry = context.getProfileRegistry();
      registry.initializeDefault({ profileId: ${JSON.stringify(defaultId)} });
      mkdirSync(registry.layout.profilesRoot, { recursive: true, mode: 0o700 });
      mkdirSync(registry.profileRoot(${JSON.stringify(defaultId)}), { mode: 0o700 });
      recovery.createProfileRecoveryJournalForTests({ managedRoot: ${JSON.stringify(managedRoot)}, operation: "create", profileId: ${JSON.stringify(personalId)}, expectedGeneration: 1, operationId: ${JSON.stringify(operationId)} });
      mkdirSync(registry.profileRoot(${JSON.stringify(personalId)}), { mode: 0o700 });
      ${kind === "non-empty"
        ? `writeFileSync(registry.profileRoot(${JSON.stringify(personalId)}) + "/private.txt", "private", { mode: 0o600 });`
        : `symlinkSync("../${defaultId}", registry.profileRoot(${JSON.stringify(personalId)}) + "/unsafe");`}
      recovery.updateProfileRecovery(${JSON.stringify(managedRoot)}, "profile-root-created");
      let message = "";
      try { lifecycle.recoverProfileLifecycle({ confirmed: true, expectedGeneration: 1 }); } catch (error) { message = error.message; }
      console.log(JSON.stringify({ message, journal: recovery.readProfileRecoveryJournal(${JSON.stringify(managedRoot)})?.operation }));
    `);
    assert.equal(result.journal, "create");
    assert.match(String(result.message), kind === "non-empty" ? /only discard an empty/ : /symbolic links/);
  }
});

test("interrupted reset rolls its tombstone back without loss or duplication", () => {
  const { managedRoot } = fixture("reset");
  const result = runScenario(managedRoot, String.raw`
    import assert from "node:assert/strict";
    import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
    import { join } from "node:path";
    const lifecycle = await import(${JSON.stringify(moduleUrl("lib/profile-lifecycle.ts"))});
    const context = await import(${JSON.stringify(moduleUrl("lib/profile-context.ts"))});
    const recovery = await import(${JSON.stringify(moduleUrl("lib/profile-recovery.ts"))});
    const registry = context.getProfileRegistry();
    registry.initializeDefault({ profileId: ${JSON.stringify(defaultId)} });
    mkdirSync(registry.layout.profilesRoot, { recursive: true, mode: 0o700 });
    mkdirSync(registry.profileRoot(${JSON.stringify(defaultId)}), { mode: 0o700 });
    mkdirSync(registry.profileRoot(${JSON.stringify(testingId)}), { mode: 0o700 });
    writeFileSync(join(registry.profileRoot(${JSON.stringify(testingId)}), "state.txt"), "one copy", { mode: 0o600 });
    registry.create({ profileId: ${JSON.stringify(testingId)}, displayName: "Canary", kind: "testing", expectedGeneration: 1 });
    const tombstoneName = "reset-${testingId}-${operationId}";
    const tombstones = join(registry.layout.registryRoot, "tombstones");
    mkdirSync(tombstones, { mode: 0o700 });
    recovery.createProfileRecoveryJournalForTests({ managedRoot: ${JSON.stringify(managedRoot)}, operation: "reset", profileId: ${JSON.stringify(testingId)}, expectedGeneration: 2, tombstoneName, operationId: ${JSON.stringify(operationId)} });
    renameSync(registry.profileRoot(${JSON.stringify(testingId)}), join(tombstones, tombstoneName));
    recovery.syncProfileDirectory(registry.layout.profilesRoot); recovery.syncProfileDirectory(tombstones);
    recovery.updateProfileRecovery(${JSON.stringify(managedRoot)}, "tombstone-moved");
    const repaired = lifecycle.recoverProfileLifecycle({ confirmed: true, expectedGeneration: 2 });
    console.log(JSON.stringify({ resolution: repaired.resolution, value: readFileSync(join(registry.profileRoot(${JSON.stringify(testingId)}), "state.txt"), "utf8"), tombstone: existsSync(join(tombstones, tombstoneName)) }));
  `);
  assert.deepEqual(result, { resolution: "rolled-back", value: "one copy", tombstone: false });
});

test("committed delete Recovery finalizes its app-owned tombstone", () => {
  const { managedRoot } = fixture("delete");
  const result = runScenario(managedRoot, String.raw`
    import { mkdirSync, renameSync, writeFileSync, existsSync } from "node:fs";
    import { join } from "node:path";
    const lifecycle = await import(${JSON.stringify(moduleUrl("lib/profile-lifecycle.ts"))});
    const context = await import(${JSON.stringify(moduleUrl("lib/profile-context.ts"))});
    const recovery = await import(${JSON.stringify(moduleUrl("lib/profile-recovery.ts"))});
    const registry = context.getProfileRegistry();
    registry.initializeDefault({ profileId: ${JSON.stringify(defaultId)} });
    mkdirSync(registry.layout.profilesRoot, { recursive: true, mode: 0o700 });
    mkdirSync(registry.profileRoot(${JSON.stringify(defaultId)}), { mode: 0o700 });
    mkdirSync(registry.profileRoot(${JSON.stringify(personalId)}), { mode: 0o700 });
    writeFileSync(join(registry.profileRoot(${JSON.stringify(personalId)}), "state.txt"), "delete me", { mode: 0o600 });
    registry.create({ profileId: ${JSON.stringify(personalId)}, displayName: "Work", kind: "personal", expectedGeneration: 1 });
    const tombstoneName = "delete-${personalId}-${operationId}";
    const tombstones = join(registry.layout.registryRoot, "tombstones"); mkdirSync(tombstones, { mode: 0o700 });
    recovery.createProfileRecoveryJournalForTests({ managedRoot: ${JSON.stringify(managedRoot)}, operation: "delete", profileId: ${JSON.stringify(personalId)}, expectedGeneration: 2, tombstoneName, operationId: ${JSON.stringify(operationId)} });
    renameSync(registry.profileRoot(${JSON.stringify(personalId)}), join(tombstones, tombstoneName));
    recovery.updateProfileRecovery(${JSON.stringify(managedRoot)}, "tombstone-moved");
    registry.remove({ profileId: ${JSON.stringify(personalId)}, expectedGeneration: 2 });
    recovery.updateProfileRecovery(${JSON.stringify(managedRoot)}, "registry-committed");
    const repaired = lifecycle.recoverProfileLifecycle({ confirmed: true, expectedGeneration: 3 });
    console.log(JSON.stringify({ resolution: repaired.resolution, tombstone: existsSync(join(tombstones, tombstoneName)), registered: registry.read().profiles.some((profile) => profile.id === ${JSON.stringify(personalId)}) }));
  `);
  assert.deepEqual(result, { resolution: "finalized", tombstone: false, registered: false });
});

test("Recovery accepts an exact committed generation when the sealed journal phase is stale", () => {
  const { managedRoot } = fixture("delete-stale-phase");
  const result = runScenario(managedRoot, String.raw`
    import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const lifecycle = await import(${JSON.stringify(moduleUrl("lib/profile-lifecycle.ts"))});
    const context = await import(${JSON.stringify(moduleUrl("lib/profile-context.ts"))});
    const recovery = await import(${JSON.stringify(moduleUrl("lib/profile-recovery.ts"))});
    const registry = context.getProfileRegistry();
    registry.initializeDefault({ profileId: ${JSON.stringify(defaultId)} });
    mkdirSync(registry.layout.profilesRoot, { recursive: true, mode: 0o700 });
    mkdirSync(registry.profileRoot(${JSON.stringify(defaultId)}), { mode: 0o700 });
    mkdirSync(registry.profileRoot(${JSON.stringify(personalId)}), { mode: 0o700 });
    writeFileSync(join(registry.profileRoot(${JSON.stringify(personalId)}), "state.txt"), "delete me", { mode: 0o600 });
    registry.create({ profileId: ${JSON.stringify(personalId)}, displayName: "Work", kind: "personal", expectedGeneration: 1 });
    const tombstoneName = "delete-${personalId}-${operationId}";
    const tombstones = join(registry.layout.registryRoot, "tombstones");
    mkdirSync(tombstones, { mode: 0o700 });
    recovery.createProfileRecoveryJournalForTests({ managedRoot: ${JSON.stringify(managedRoot)}, operation: "delete", profileId: ${JSON.stringify(personalId)}, expectedGeneration: 2, tombstoneName, operationId: ${JSON.stringify(operationId)} });
    renameSync(registry.profileRoot(${JSON.stringify(personalId)}), join(tombstones, tombstoneName));
    recovery.updateProfileRecovery(${JSON.stringify(managedRoot)}, "tombstone-moved");
    registry.remove({ profileId: ${JSON.stringify(personalId)}, expectedGeneration: 2 });
    // Simulate a crash after the registry's atomic generation-3 commit but
    // before the separate journal phase could be advanced.
    const repaired = lifecycle.recoverProfileLifecycle({ confirmed: true, expectedGeneration: 3 });
    console.log(JSON.stringify({ resolution: repaired.resolution, tombstone: existsSync(join(tombstones, tombstoneName)), journal: recovery.readProfileRecoveryJournal(${JSON.stringify(managedRoot)}) }));
  `);
  assert.deepEqual(result, { resolution: "finalized", tombstone: false, journal: null });
});

test("registry fallback after an interrupted committed delete restores the tombstone instead of losing data", () => {
  const { managedRoot } = fixture("delete-registry-fallback");
  const result = runScenario(managedRoot, String.raw`
    import { mkdirSync, renameSync, writeFileSync, readFileSync } from "node:fs";
    import { join } from "node:path";
    const lifecycle = await import(${JSON.stringify(moduleUrl("lib/profile-lifecycle.ts"))});
    const context = await import(${JSON.stringify(moduleUrl("lib/profile-context.ts"))});
    const recovery = await import(${JSON.stringify(moduleUrl("lib/profile-recovery.ts"))});
    const registry = context.getProfileRegistry();
    registry.initializeDefault({ profileId: ${JSON.stringify(defaultId)} });
    mkdirSync(registry.layout.profilesRoot, { recursive: true, mode: 0o700 });
    mkdirSync(registry.profileRoot(${JSON.stringify(defaultId)}), { mode: 0o700 });
    mkdirSync(registry.profileRoot(${JSON.stringify(personalId)}), { mode: 0o700 });
    writeFileSync(join(registry.profileRoot(${JSON.stringify(personalId)}), "state.txt"), "must survive", { mode: 0o600 });
    registry.create({ profileId: ${JSON.stringify(personalId)}, displayName: "Work", kind: "personal", expectedGeneration: 1 });
    const tombstoneName = "delete-${personalId}-${operationId}";
    const tombstones = join(registry.layout.registryRoot, "tombstones"); mkdirSync(tombstones, { mode: 0o700 });
    recovery.createProfileRecoveryJournalForTests({ managedRoot: ${JSON.stringify(managedRoot)}, operation: "delete", profileId: ${JSON.stringify(personalId)}, expectedGeneration: 2, tombstoneName, operationId: ${JSON.stringify(operationId)} });
    renameSync(registry.profileRoot(${JSON.stringify(personalId)}), join(tombstones, tombstoneName));
    recovery.updateProfileRecovery(${JSON.stringify(managedRoot)}, "tombstone-moved");
    registry.remove({ profileId: ${JSON.stringify(personalId)}, expectedGeneration: 2 });
    recovery.updateProfileRecovery(${JSON.stringify(managedRoot)}, "registry-committed");
    writeFileSync(registry.layout.registryFile, "corrupt", { mode: 0o600 });
    const repaired = lifecycle.recoverProfileLifecycle({ confirmed: true, expectedGeneration: 2 });
    console.log(JSON.stringify({ resolution: repaired.resolution, value: readFileSync(join(registry.profileRoot(${JSON.stringify(personalId)}), "state.txt"), "utf8"), registered: registry.read().profiles.some((profile) => profile.id === ${JSON.stringify(personalId)}) }));
  `);
  assert.deepEqual(result, { resolution: "rolled-back", value: "must survive", registered: true });
});

test("backup-derived restore orphan is discarded only when its sealed origin matches the journal", () => {
  const { managedRoot } = fixture("restore");
  const source = join(managedRoot, "backup-source");
  mkdirSync(source, { mode: 0o700 });
  writeFileSync(join(source, "state.txt"), "restored bytes", { mode: 0o600 });
  const backup = createProfileBackup({
    profileRoot: source,
    sourceProfile: { id: defaultId, displayName: "Default", type: "default" },
    now: "2026-08-13T00:00:00.000Z",
  });
  const backupBase64 = Buffer.from(backup).toString("base64");
  const result = runScenario(managedRoot, String.raw`
    import { mkdirSync, existsSync } from "node:fs";
    const lifecycle = await import(${JSON.stringify(moduleUrl("lib/profile-lifecycle.ts"))});
    const context = await import(${JSON.stringify(moduleUrl("lib/profile-context.ts"))});
    const recovery = await import(${JSON.stringify(moduleUrl("lib/profile-recovery.ts"))});
    const backups = await import(${JSON.stringify(moduleUrl("lib/profile-backup.ts"))});
    const registry = context.getProfileRegistry();
    registry.initializeDefault({ profileId: ${JSON.stringify(defaultId)} });
    mkdirSync(registry.layout.profilesRoot, { recursive: true, mode: 0o700 });
    mkdirSync(registry.profileRoot(${JSON.stringify(defaultId)}), { mode: 0o700 });
    const bytes = Buffer.from(${JSON.stringify(backupBase64)}, "base64");
    const manifest = backups.inspectProfileBackup(bytes).manifestSha256;
    recovery.createProfileRecoveryJournalForTests({ managedRoot: ${JSON.stringify(managedRoot)}, operation: "restore", profileId: ${JSON.stringify(personalId)}, expectedGeneration: 1, backupManifestSha256: manifest, operationId: ${JSON.stringify(operationId)} });
    backups.restoreProfileBackup({ bytes, targetRoot: registry.profileRoot(${JSON.stringify(personalId)}), restoreMarker: { operationId: ${JSON.stringify(operationId)}, profileId: ${JSON.stringify(personalId)}, backupManifestSha256: manifest } });
    recovery.updateProfileRecovery(${JSON.stringify(managedRoot)}, "profile-root-restored");
    const repaired = lifecycle.recoverProfileLifecycle({ confirmed: true, expectedGeneration: 1 });
    console.log(JSON.stringify({ resolution: repaired.resolution, removed: !existsSync(registry.profileRoot(${JSON.stringify(personalId)})) }));
  `);
  assert.deepEqual(result, { resolution: "rolled-back", removed: true });
});

test("committed restore retains its sealed origin until and after explicit Recovery", () => {
  const { managedRoot } = fixture("restore-committed");
  const source = join(managedRoot, "backup-source");
  mkdirSync(source, { mode: 0o700 });
  writeFileSync(join(source, "state.txt"), "restored bytes", { mode: 0o600 });
  const backup = createProfileBackup({
    profileRoot: source,
    sourceProfile: { id: defaultId, displayName: "Default", type: "default" },
    now: "2026-08-13T00:00:00.000Z",
  });
  const result = runScenario(managedRoot, String.raw`
    import { existsSync, mkdirSync } from "node:fs";
    import { join } from "node:path";
    const lifecycle = await import(${JSON.stringify(moduleUrl("lib/profile-lifecycle.ts"))});
    const context = await import(${JSON.stringify(moduleUrl("lib/profile-context.ts"))});
    const recovery = await import(${JSON.stringify(moduleUrl("lib/profile-recovery.ts"))});
    const backups = await import(${JSON.stringify(moduleUrl("lib/profile-backup.ts"))});
    const registry = context.getProfileRegistry();
    registry.initializeDefault({ profileId: ${JSON.stringify(defaultId)} });
    mkdirSync(registry.layout.profilesRoot, { recursive: true, mode: 0o700 });
    mkdirSync(registry.profileRoot(${JSON.stringify(defaultId)}), { mode: 0o700 });
    const bytes = Buffer.from(${JSON.stringify(Buffer.from(backup).toString("base64"))}, "base64");
    const manifest = backups.inspectProfileBackup(bytes).manifestSha256;
    recovery.createProfileRecoveryJournalForTests({ managedRoot: ${JSON.stringify(managedRoot)}, operation: "restore", profileId: ${JSON.stringify(personalId)}, expectedGeneration: 1, backupManifestSha256: manifest, operationId: ${JSON.stringify(operationId)} });
    backups.restoreProfileBackup({ bytes, targetRoot: registry.profileRoot(${JSON.stringify(personalId)}), restoreMarker: { operationId: ${JSON.stringify(operationId)}, profileId: ${JSON.stringify(personalId)}, backupManifestSha256: manifest } });
    recovery.updateProfileRecovery(${JSON.stringify(managedRoot)}, "profile-root-restored");
    registry.create({ profileId: ${JSON.stringify(personalId)}, displayName: "Restored", kind: "personal", expectedGeneration: 1 });
    recovery.updateProfileRecovery(${JSON.stringify(managedRoot)}, "registry-committed");
    const marker = join(registry.profileRoot(${JSON.stringify(personalId)}), backups.PROFILE_RESTORE_ORIGIN_MARKER);
    const before = existsSync(marker);
    const repaired = lifecycle.recoverProfileLifecycle({ confirmed: true, expectedGeneration: 2 });
    console.log(JSON.stringify({ resolution: repaired.resolution, before, after: existsSync(marker), journal: recovery.readProfileRecoveryJournal(${JSON.stringify(managedRoot)}) }));
  `);
  assert.deepEqual(result, { resolution: "finalized", before: true, after: true, journal: null });
});

test("valid orphaned Default copy resumes from its retained migration manifest without duplicating legacy data", () => {
  const { managedRoot } = fixture("default-resume");
  writeFileSync(join(managedRoot, "legacy.txt"), "legacy remains", { mode: 0o600 });
  const result = runScenario(managedRoot, String.raw`
    import { readFileSync } from "node:fs";
    import { join } from "node:path";
    const lifecycle = await import(${JSON.stringify(moduleUrl("lib/profile-lifecycle.ts"))});
    const context = await import(${JSON.stringify(moduleUrl("lib/profile-context.ts"))});
    const migration = await import(${JSON.stringify(moduleUrl("lib/profile-migration.ts"))});
    const recovery = await import(${JSON.stringify(moduleUrl("lib/profile-recovery.ts"))});
    const registry = context.getProfileRegistry();
    recovery.createProfileRecoveryJournalForTests({ managedRoot: ${JSON.stringify(managedRoot)}, operation: "default-migration", profileId: ${JSON.stringify(defaultId)}, expectedGeneration: 0, operationId: ${JSON.stringify(operationId)} });
    migration.migrateLegacyDataToDefault({ managedRoot: ${JSON.stringify(managedRoot)}, profilesRoot: registry.layout.profilesRoot, recoveryRoot: join(registry.layout.registryRoot, "recovery"), profileId: ${JSON.stringify(defaultId)}, activateRegistry() {} });
    recovery.updateProfileRecovery(${JSON.stringify(managedRoot)}, "profile-root-restored");
    const repaired = lifecycle.recoverProfileLifecycle({ confirmed: true, expectedGeneration: 0 });
    console.log(JSON.stringify({ resolution: repaired.resolution, original: readFileSync(join(${JSON.stringify(managedRoot)}, "legacy.txt"), "utf8"), adopted: readFileSync(join(registry.profileRoot(${JSON.stringify(defaultId)}), "legacy.txt"), "utf8"), profiles: registry.read().profiles.length }));
  `);
  assert.deepEqual(result, { resolution: "resumed", original: "legacy remains", adopted: "legacy remains", profiles: 1 });
});

test("backup and migration reject non-ASCII confusables, case collisions, and globally sort nested files", () => {
  const { managedRoot } = fixture("portable-paths");
  const source = join(managedRoot, "source");
  mkdirSync(source, { mode: 0o700 });
  for (const name of ["repositorieſ.json", "datasetσ.json", "sql-confirmationß.json", "credentialſ", "modelσ"]) {
    const path = join(source, name);
    writeFileSync(path, "private", { mode: 0o600 });
    assert.throws(() => createProfileBackup({ profileRoot: source, sourceProfile: { id: defaultId, displayName: "Default", type: "default" } }), /printable ASCII/);
    assert.throws(() => inventoryLegacyProfileData(source), /printable ASCII/);
    rmSync(path);
  }
  mkdirSync(join(source, "A"), { mode: 0o700 });
  try {
    mkdirSync(join(source, "a"), { mode: 0o700 });
    assert.throws(() => createProfileBackup({ profileRoot: source, sourceProfile: { id: defaultId, displayName: "Default", type: "default" } }), /colliding paths/);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  rmSync(source, { recursive: true });
  mkdirSync(join(source, "a"), { recursive: true, mode: 0o700 });
  writeFileSync(join(source, "a", "x"), "nested", { mode: 0o600 });
  writeFileSync(join(source, "a-"), "sibling", { mode: 0o600 });
  const envelope = JSON.parse(Buffer.from(createProfileBackup({
    profileRoot: source,
    sourceProfile: { id: defaultId, displayName: "Default", type: "default" },
  })).toString("utf8")) as { files: Array<{ path: string }> };
  assert.deepEqual(envelope.files.map(({ path }) => path), ["a-", "a/x"]);
});

test("Recovery journals bind tombstones to operation, profile, and operation identity and clamp clock rollback", () => {
  const { managedRoot } = fixture("journal-binding");
  createProfileRecoveryJournalForTests({
    managedRoot,
    operation: "delete",
    profileId: personalId,
    expectedGeneration: 1,
    operationId,
    tombstoneName: `delete-${personalId}-${operationId}`,
    now: "2026-08-13T12:00:00.000Z",
  });
  const updated = updateProfileRecovery(managedRoot, "tombstone-moved", "2025-01-01T00:00:00.000Z");
  assert.equal(updated.updatedAt, "2026-08-13T12:00:00.000Z");
  clearProfileRecovery(managedRoot);
  assert.throws(() => createProfileRecoveryJournalForTests({
    managedRoot,
    operation: "delete",
    profileId: personalId,
    expectedGeneration: 1,
    operationId,
    tombstoneName: `delete-${defaultId}-${operationId}`,
  }), /operation and phase do not match/);
});
