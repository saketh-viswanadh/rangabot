import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createProfileBackup } from "../lib/profile-backup.ts";
import { validateProfileDomainRoot } from "../lib/profile-domain-validation.ts";
import { migrateLegacyDataToDefault } from "../lib/profile-migration.ts";

const defaultId = "10000000-0000-4000-8000-000000000001";

function privateRoot(prefix: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  chmodSync(root, 0o700);
  return root;
}

function createDatabase(path: string, value = "synthetic") {
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(path);
  try {
    database.exec("CREATE TABLE synthetic_domain_fixture (value TEXT NOT NULL)");
    database.prepare("INSERT INTO synthetic_domain_fixture (value) VALUES (?)").run(value);
  } finally {
    database.close();
  }
  chmodSync(path, 0o600);
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function sha256(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function moduleUrl(path: string) {
  return pathToFileURL(resolve(path)).href;
}

test("validates closed SQLite domains and bounded known JSON without changing bytes", () => {
  const root = privateRoot("rangabot-profile-domain-valid-");
  createDatabase(join(root, "rangabot.db"), "conversation");
  createDatabase(join(root, "rangabot-memory.db"), "memory");
  createDatabase(join(root, "knowledge", "indexes", "knowledge.db"), "knowledge");
  createDatabase(join(root, "knowledge", "backups", "knowledge-2026-08-13T00-00-00Z-a1b2c3d4.db"), "backup");
  writeJson(join(root, "repositories.json"), [{
    id: "repository-1", name: "Synthetic", path: "/synthetic/not-opened", addedAt: "2026-08-13T00:00:00.000Z",
  }]);
  writeJson(join(root, "datasets.json"), []);
  writeJson(join(root, "sql-confirmations.json"), []);
  writeJson(join(root, "desktop-preferences.json"), {
    schemaVersion: 1, preferredName: "Local", welcomeMode: "thoughts", appearance: "dark", palette: "moss",
    revision: 1, updatedAt: "2026-08-13T00:00:00.000Z", import: null,
  });
  writeJson(join(root, "model-preferences.json"), {
    schemaVersion: 2, selectedModel: "qwen3:8b", contextTokens: 4096, revision: 1,
    updatedAt: "2026-08-13T00:00:00.000Z",
  });
  const databasePath = join(root, "rangabot.db");
  const before = { sha256: sha256(databasePath), size: statSync(databasePath).size, mtimeMs: statSync(databasePath).mtimeMs };
  const receipt = validateProfileDomainRoot(root);
  assert.deepEqual({ sqliteDatabases: receipt.sqliteDatabases, jsonStores: receipt.jsonStores }, {
    sqliteDatabases: 4,
    jsonStores: 5,
  });
  assert.deepEqual({ sha256: sha256(databasePath), size: statSync(databasePath).size, mtimeMs: statSync(databasePath).mtimeMs }, before);
  assert.equal(existsSync("/synthetic/not-opened"), false);
});

test("fails closed on corrupt SQLite and malformed known JSON", () => {
  const corruptDatabase = privateRoot("rangabot-profile-domain-corrupt-db-");
  writeFileSync(join(corruptDatabase, "rangabot.db"), "not a sqlite database", { mode: 0o600 });
  assert.throws(() => validateProfileDomainRoot(corruptDatabase), /SQLite database failed its integrity check/);

  const corruptJson = privateRoot("rangabot-profile-domain-corrupt-json-");
  writeFileSync(join(corruptJson, "model-preferences.json"), "{", { mode: 0o600 });
  assert.throws(() => validateProfileDomainRoot(corruptJson), /JSON store is malformed/);

  writeJson(join(corruptJson, "model-preferences.json"), {
    schemaVersion: 2, selectedModel: "qwen3:8b", contextTokens: 1, revision: 0, updatedAt: null,
  });
  assert.throws(() => validateProfileDomainRoot(corruptJson), /incompatible schema/);

  const corruptBackup = privateRoot("rangabot-profile-domain-corrupt-backup-");
  mkdirSync(join(corruptBackup, "knowledge", "backups"), { recursive: true, mode: 0o700 });
  writeFileSync(join(corruptBackup, "knowledge", "backups", "knowledge-2026-08-13T00-00-00Z-a1b2c3d4.db"), "bad", { mode: 0o600 });
  assert.throws(() => validateProfileDomainRoot(corruptBackup), /SQLite database failed its integrity check/);
});

test("rejects symbolic links, hard links, and non-private profile entries", () => {
  const outside = privateRoot("rangabot-profile-domain-outside-");
  const outsideFile = join(outside, "outside.txt");
  writeFileSync(outsideFile, "outside", { mode: 0o600 });

  const linked = privateRoot("rangabot-profile-domain-linked-");
  linkSync(outsideFile, join(linked, "hard-linked.txt"));
  assert.throws(() => validateProfileDomainRoot(linked), /hard-linked/);

  const symlinked = privateRoot("rangabot-profile-domain-symlinked-");
  symlinkSync(outsideFile, join(symlinked, "linked.txt"));
  assert.throws(() => validateProfileDomainRoot(symlinked), /symbolic links/);

  const publicEntry = privateRoot("rangabot-profile-domain-mode-");
  writeFileSync(join(publicEntry, "state.txt"), "state", { mode: 0o644 });
  if (process.platform !== "win32") {
    assert.throws(() => validateProfileDomainRoot(publicEntry), /owner-private/);
  }
});

test("Default migration refuses semantic corruption before registry activation and removes its staged copy", () => {
  const managedRoot = privateRoot("rangabot-profile-domain-migrate-");
  const original = join(managedRoot, "rangabot.db");
  writeFileSync(original, "corrupt legacy sqlite", { mode: 0o600 });
  let activated = false;
  assert.throws(() => migrateLegacyDataToDefault({
    managedRoot,
    profilesRoot: join(managedRoot, "profiles"),
    recoveryRoot: join(managedRoot, "profile-recovery"),
    profileId: "8a38e07f-22c4-4c67-a5d1-4d381bc8bd0a",
    activateRegistry() { activated = true; },
  }), /SQLite database failed its integrity check/);
  assert.equal(activated, false);
  assert.equal(existsSync(join(managedRoot, "profiles", "8a38e07f-22c4-4c67-a5d1-4d381bc8bd0a")), false);
  assert.equal(readFileSync(original, "utf8"), "corrupt legacy sqlite");
});

test("restore refuses a corrupt backup domain before registry cutover", () => {
  const root = privateRoot("rangabot-profile-domain-restore-");
  const managedRoot = join(root, "managed");
  const source = join(root, "backup-source");
  mkdirSync(managedRoot, { mode: 0o700 });
  mkdirSync(source, { mode: 0o700 });
  writeFileSync(join(source, "rangabot.db"), "corrupt backup sqlite", { mode: 0o600 });
  const bytes = createProfileBackup({
    profileRoot: source,
    sourceProfile: { id: defaultId, displayName: "Default", type: "default" },
    now: "2026-08-13T00:00:00.000Z",
  });
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", String.raw`
    import { mkdirSync } from "node:fs";
    const lifecycle = await import(${JSON.stringify(moduleUrl("lib/profile-lifecycle.ts"))});
    const context = await import(${JSON.stringify(moduleUrl("lib/profile-context.ts"))});
    const recovery = await import(${JSON.stringify(moduleUrl("lib/profile-recovery.ts"))});
    const registry = context.getProfileRegistry();
    registry.initializeDefault({ profileId: ${JSON.stringify(defaultId)} });
    mkdirSync(registry.layout.profilesRoot, { recursive: true, mode: 0o700 });
    mkdirSync(registry.profileRoot(${JSON.stringify(defaultId)}), { mode: 0o700 });
    let message = "";
    try {
      lifecycle.restoreProfile({ bytes: Buffer.from(${JSON.stringify(Buffer.from(bytes).toString("base64"))}, "base64"), displayName: "Corrupt", kind: "personal", expectedGeneration: 1 });
    } catch (error) { message = error.message; }
    const snapshot = registry.read();
    const journal = recovery.readProfileRecoveryJournal(${JSON.stringify(managedRoot)});
    console.log(JSON.stringify({ message, profiles: snapshot.profiles.length, journal: journal?.operation }));
  `], {
    cwd: root,
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
  const result = JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "null") as Record<string, unknown>;
  assert.match(String(result.message), /SQLite database failed its integrity check/);
  assert.equal(result.profiles, 1);
  assert.equal(result.journal, "restore");
});

test("switch refuses a semantically corrupt target before changing the active profile", () => {
  const root = privateRoot("rangabot-profile-domain-switch-");
  const managedRoot = join(root, "managed");
  mkdirSync(managedRoot, { mode: 0o700 });
  const personalId = "20000000-0000-4000-8000-000000000002";
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", String.raw`
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const lifecycle = await import(${JSON.stringify(moduleUrl("lib/profile-lifecycle.ts"))});
    const context = await import(${JSON.stringify(moduleUrl("lib/profile-context.ts"))});
    const registry = context.getProfileRegistry();
    registry.initializeDefault({ profileId: ${JSON.stringify(defaultId)} });
    mkdirSync(registry.layout.profilesRoot, { recursive: true, mode: 0o700 });
    mkdirSync(registry.profileRoot(${JSON.stringify(defaultId)}), { mode: 0o700 });
    mkdirSync(registry.profileRoot(${JSON.stringify(personalId)}), { mode: 0o700 });
    writeFileSync(join(registry.profileRoot(${JSON.stringify(personalId)}), "rangabot.db"), "not a sqlite database", { mode: 0o600 });
    registry.create({ profileId: ${JSON.stringify(personalId)}, displayName: "Corrupt", kind: "personal", expectedGeneration: 1 });
    let message = "";
    try { lifecycle.switchProfile({ profileId: ${JSON.stringify(personalId)}, expectedGeneration: 2 }); }
    catch (error) { message = error.message; }
    const snapshot = registry.read();
    console.log(JSON.stringify({ message, activeProfileId: snapshot.activeProfileId, generation: snapshot.generation }));
  `], {
    cwd: root,
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
  const result = JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "null") as Record<string, unknown>;
  assert.match(String(result.message), /file is not a database|SQLite database failed its integrity check/);
  assert.deepEqual({ activeProfileId: result.activeProfileId, generation: result.generation }, {
    activeProfileId: defaultId,
    generation: 2,
  });
});
