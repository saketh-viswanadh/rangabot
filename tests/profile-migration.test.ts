import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { inventoryLegacyProfileData, migrateLegacyDataToDefault } from "../lib/profile-migration.ts";

const profileId = "8a38e07f-22c4-4c67-a5d1-4d381bc8bd0a";

function createSyntheticDatabase(path: string, value: string) {
  const database = new DatabaseSync(path);
  try {
    database.exec("CREATE TABLE synthetic_profile_fixture (value TEXT NOT NULL)");
    database.prepare("INSERT INTO synthetic_profile_fixture (value) VALUES (?)").run(value);
  } finally {
    database.close();
  }
  chmodSync(path, 0o600);
}

function fixture() {
  const managedRoot = mkdtempSync(join(tmpdir(), "rangabot-profile-migrate-"));
  chmodSync(managedRoot, 0o700);
  mkdirSync(join(managedRoot, "knowledge", "indexes"), { recursive: true, mode: 0o700 });
  mkdirSync(join(managedRoot, "models"), { mode: 0o700 });
  mkdirSync(join(managedRoot, "tmp"), { mode: 0o700 });
  createSyntheticDatabase(join(managedRoot, "rangabot.db"), "chat");
  createSyntheticDatabase(join(managedRoot, "rangabot-memory.db"), "memory");
  createSyntheticDatabase(join(managedRoot, "knowledge", "indexes", "knowledge.db"), "knowledge");
  writeFileSync(join(managedRoot, "repositories.json"), "[]", { mode: 0o600 });
  writeFileSync(join(managedRoot, "models", "weight"), "shared", { mode: 0o600 });
  writeFileSync(join(managedRoot, "tmp", "scratch"), "shared", { mode: 0o600 });
  return managedRoot;
}

test("preflights and atomically adopts legacy data without touching the original or shared models", () => {
  const managedRoot = fixture();
  let activated = "";
  const receipt = migrateLegacyDataToDefault({
    managedRoot,
    profilesRoot: join(managedRoot, "profiles"),
    recoveryRoot: join(managedRoot, "profile-recovery"),
    profileId,
    activateRegistry(id) { activated = id; },
    now: "2026-08-13T12:00:00.000Z",
  });
  assert.equal(activated, profileId);
  assert.deepEqual(readFileSync(join(managedRoot, "rangabot.db")), readFileSync(join(receipt.profileRoot, "rangabot.db")));
  assert.equal(readFileSync(join(receipt.profileRoot, "repositories.json"), "utf8"), "[]");
  assert.equal(readFileSync(join(managedRoot, "models", "weight"), "utf8"), "shared");
  assert.equal(existsSync(join(receipt.profileRoot, "models")), false);
  assert.equal(existsSync(join(receipt.profileRoot, "tmp")), false);
  assert.equal(JSON.parse(readFileSync(receipt.recoveryManifestPath, "utf8")).originalDataRetained, true);
});

test("rolls back an unactivated staged copy after a low-space failure", () => {
  const managedRoot = fixture();
  let copied = 0;
  assert.throws(() => migrateLegacyDataToDefault({
    managedRoot,
    profilesRoot: join(managedRoot, "profiles"),
    recoveryRoot: join(managedRoot, "profile-recovery"),
    profileId,
    copyFile() {
      copied += 1;
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    },
    activateRegistry() { throw new Error("must not activate"); },
  }), /disk full/);
  assert.equal(existsSync(join(managedRoot, "profiles", profileId)), false);
  const database = new DatabaseSync(join(managedRoot, "rangabot.db"), { readOnly: true });
  try {
    assert.equal((database.prepare("SELECT value FROM synthetic_profile_fixture").get() as { value: string }).value, "chat");
  } finally {
    database.close();
  }
  assert.equal(copied, 1);
});

test("retains the verified final root when registry activation may have committed before throwing", () => {
  const managedRoot = fixture();
  let durablyActivated = false;
  assert.throws(() => migrateLegacyDataToDefault({
    managedRoot,
    profilesRoot: join(managedRoot, "profiles"),
    recoveryRoot: join(managedRoot, "profile-recovery"),
    profileId,
    activateRegistry() {
      durablyActivated = true;
      throw new Error("registry lock release failed after durable commit");
    },
  }), /registry lock release failed after durable commit/);
  const retainedRoot = join(managedRoot, "profiles", profileId);
  assert.equal(durablyActivated, true);
  assert.equal(existsSync(retainedRoot), true);
  assert.deepEqual(readFileSync(join(retainedRoot, "rangabot.db")), readFileSync(join(managedRoot, "rangabot.db")));
  assert.equal(existsSync(join(managedRoot, "rangabot.db")), true);
});

test("detects source corruption and, on POSIX, unsafe owner modes before cutover", () => {
  const managedRoot = fixture();
  const inventory = inventoryLegacyProfileData(managedRoot);
  writeFileSync(join(managedRoot, "rangabot.db"), "changed", { mode: 0o600 });
  assert.throws(() => migrateLegacyDataToDefault({
    managedRoot,
    profilesRoot: join(managedRoot, "profiles"),
    recoveryRoot: join(managedRoot, "profile-recovery"),
    profileId,
    inventory: () => inventory,
    activateRegistry() { throw new Error("must not activate"); },
  }), /changed after preflight/);

  if (process.platform !== "win32") {
    const unsafe = fixture();
    chmodSync(unsafe, 0o755);
    assert.throws(() => inventoryLegacyProfileData(unsafe), /owner-private/);
  }
});

test("rejects a symlinked migration container before copying or activating", () => {
  const managedRoot = fixture();
  const outside = mkdtempSync(join(tmpdir(), "rangabot-profile-migrate-outside-"));
  chmodSync(outside, 0o700);
  symlinkSync(outside, join(managedRoot, "profiles-v1"));
  let activated = false;
  assert.throws(() => migrateLegacyDataToDefault({
    managedRoot,
    profilesRoot: join(managedRoot, "profiles-v1", "data"),
    recoveryRoot: join(managedRoot, "profiles-v1", "recovery"),
    profileId,
    activateRegistry() { activated = true; },
  }), /symbolic-link/);
  assert.equal(activated, false);
  assert.equal(existsSync(join(outside, "data")), false);
});
