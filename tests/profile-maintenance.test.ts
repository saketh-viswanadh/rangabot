import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { ProfileContext } from "../lib/profile-context.ts";
import {
  acquireProfileMaintenanceBinding,
  assertVerifiedProfileMaintenanceBinding,
} from "../lib/profile-maintenance.ts";
import {
  clearProfileRecovery,
  createProfileRecoveryJournalForTests,
} from "../lib/profile-recovery.ts";
import { acquireRuntimeLease, RuntimeLeaseError } from "../lib/runtime-lease.ts";

const firstProfileId = "10000000-0000-4000-8000-000000000001";
const secondProfileId = "20000000-0000-4000-8000-000000000002";
const recoveryOperationId = "30000000-0000-4000-8000-000000000003";

function activeContext(profileId: string, generation: number, profileRoot: string): ProfileContext {
  return Object.freeze({
    setupRequired: false as const,
    profile: Object.freeze({
      id: profileId,
      displayName: profileId === firstProfileId ? "Default" : "Second",
      kind: profileId === firstProfileId ? "default" as const : "personal" as const,
      protected: profileId === firstProfileId,
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
    }),
    generation,
    binding: Object.freeze({ profileId, generation }),
    profileRoot,
  });
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rangabot-profile-maintenance-")));
  chmodSync(root, 0o700);
  const first = join(root, "first");
  const second = join(root, "second");
  mkdirSync(first, { mode: 0o700 });
  mkdirSync(second, { mode: 0o700 });
  return { root, leasePath: join(root, "runtime.lock"), first, second };
}

test("an app-held runtime lease blocks offline profile maintenance", () => {
  const paths = fixture();
  const appLease = acquireRuntimeLease({
    path: paths.leasePath,
    trustedRoot: paths.root,
    role: "app",
    inspectProcess: () => "alive",
  });
  try {
    assert.throws(
      () => acquireProfileMaintenanceBinding({
        label: "Synthetic indexing",
        leasePath: paths.leasePath,
        trustedRoot: paths.root,
        environment: {},
        inspectProcess: () => "alive",
        readContext: () => activeContext(firstProfileId, 1, paths.first),
      }),
      (error) => error instanceof RuntimeLeaseError && error.code === "active",
    );
  } finally {
    appLease.release();
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("fresh owner-controlled source data is hardened before the first Recovery read", {
  skip: process.platform === "win32",
}, () => {
  const paths = fixture();
  const sentinel = join(paths.root, "tracked-source-sentinel.txt");
  writeFileSync(sentinel, "unchanged\n", { mode: 0o600 });
  chmodSync(paths.root, 0o755);
  const maintenance = acquireProfileMaintenanceBinding({
    label: "Fresh source evaluation",
    leasePath: paths.leasePath,
    trustedRoot: paths.root,
    environment: {},
    inspectProcess: () => "alive",
    readContext: () => activeContext(firstProfileId, 0, paths.root),
  });
  try {
    assert.equal(statSync(paths.root).mode & 0o777, 0o700);
    assert.equal(readFileSync(sentinel, "utf8"), "unchanged\n");
  } finally {
    maintenance.release();
    assert.equal(existsSync(paths.leasePath), false);
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("fresh-root hardening refuses a linked profile registry", {
  skip: process.platform === "win32",
}, () => {
  const paths = fixture();
  symlinkSync(paths.first, join(paths.root, "profiles-v1"));
  chmodSync(paths.root, 0o755);
  try {
    assert.throws(() => acquireProfileMaintenanceBinding({
      label: "Unsafe source evaluation",
      leasePath: paths.leasePath,
      trustedRoot: paths.root,
      environment: {},
      inspectProcess: () => "alive",
      readContext: () => activeContext(firstProfileId, 0, paths.root),
    }), /symbolic links/);
    assert.equal(existsSync(paths.leasePath), false);
    assert.equal(statSync(paths.root).mode & 0o777, 0o755);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("fresh-root hardening never repairs permissions after profile state exists", {
  skip: process.platform === "win32",
}, () => {
  const paths = fixture();
  mkdirSync(join(paths.root, "profiles-v1"), { mode: 0o700 });
  chmodSync(paths.root, 0o755);
  try {
    assert.throws(() => acquireProfileMaintenanceBinding({
      label: "Existing profile evaluation",
      leasePath: paths.leasePath,
      trustedRoot: paths.root,
      environment: {},
      inspectProcess: () => "alive",
      readContext: () => activeContext(firstProfileId, 1, paths.first),
    }), /owner-private/);
    assert.equal(existsSync(paths.leasePath), false);
    assert.equal(statSync(paths.root).mode & 0o777, 0o755);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("the Knowledge ingestion entrypoint refuses an app-held runtime lease before profile writes", () => {
  const paths = fixture();
  const appLease = acquireRuntimeLease({
    path: join(paths.root, "rangabot.db-runtime.lock"),
    trustedRoot: paths.root,
    role: "app",
  });
  try {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", resolve("scripts/ingest-knowledge.ts")], {
      cwd: resolve("."),
      env: {
        ...process.env,
        RANGABOT_RESOURCE_ROOT: resolve("."),
        RANGABOT_DATA_ROOT: paths.root,
        KNOWLEDGE_DISABLE_EMBEDDINGS: "1",
      },
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.notEqual(run.status, 0, run.stdout);
    assert.match(run.stderr, /already running or private maintenance is active/i);
    assert.equal(existsSync(join(paths.root, "knowledge")), false);
  } finally {
    appLease.release();
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("a captured maintenance binding rejects profile, generation, and root drift before a write", () => {
  const paths = fixture();
  let context = activeContext(firstProfileId, 1, paths.first);
  const maintenance = acquireProfileMaintenanceBinding({
    label: "Synthetic evaluation",
    leasePath: paths.leasePath,
    trustedRoot: paths.root,
    environment: {},
    inspectProcess: () => "alive",
    readContext: () => context,
  });
  try {
    assert.equal(maintenance.dataPath("evaluations", "results"), join(paths.first, "evaluations", "results"));
    context = activeContext(firstProfileId, 2, paths.first);
    assert.throws(() => maintenance.assertCurrent(), /active profile changed before private maintenance could write/i);

    context = activeContext(secondProfileId, 3, paths.second);
    assert.throws(() => maintenance.assertCurrent(), /active profile changed before private maintenance could write/i);

    context = activeContext(firstProfileId, 1, paths.second);
    assert.throws(() => maintenance.assertDataPath(join(paths.first, "knowledge")), /active profile changed/i);
  } finally {
    maintenance.release();
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("maintenance paths are confined to the captured profile root", () => {
  const paths = fixture();
  const maintenance = acquireProfileMaintenanceBinding({
    label: "Synthetic export",
    leasePath: paths.leasePath,
    trustedRoot: paths.root,
    environment: {},
    inspectProcess: () => "alive",
    readContext: () => activeContext(firstProfileId, 1, paths.first),
  });
  try {
    assert.doesNotThrow(() => assertVerifiedProfileMaintenanceBinding(maintenance));
    assert.throws(
      () => assertVerifiedProfileMaintenanceBinding({ assertCurrent() {} }),
      /verified private maintenance binding is required/i,
    );
    assert.throws(() => maintenance.dataPath(".."), /fixed names without traversal/i);
    assert.throws(() => maintenance.assertDataPath(join(paths.second, "result.json")), /does not belong/i);
  } finally {
    maintenance.release();
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("offline maintenance stays blocked while explicit Profile Recovery is pending", () => {
  const paths = fixture();
  createProfileRecoveryJournalForTests({
    managedRoot: paths.root,
    operation: "create",
    profileId: secondProfileId,
    expectedGeneration: 1,
    operationId: recoveryOperationId,
    now: "2026-08-13T00:00:00.000Z",
  });
  try {
    assert.throws(() => acquireProfileMaintenanceBinding({
      label: "Must not start during Recovery",
      leasePath: paths.leasePath,
      trustedRoot: paths.root,
      environment: {},
      inspectProcess: () => "alive",
      readContext: () => activeContext(firstProfileId, 1, paths.first),
    }), /Profile Recovery is required/);
    assert.equal(existsSync(paths.leasePath), false);
  } finally {
    clearProfileRecovery(paths.root);
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("a child evaluator adopts only the exact live parent maintenance lease", () => {
  const paths = fixture();
  const moduleUrl = pathToFileURL(resolve("lib/profile-maintenance.ts")).href;
  const childSource = `
    const { acquireProfileMaintenanceBinding } = await import(${JSON.stringify(moduleUrl)});
    const parent = acquireProfileMaintenanceBinding({ label: "Parent matrix" });
    const childSource = ${JSON.stringify(`
      const { acquireProfileMaintenanceBinding } = await import(${JSON.stringify(moduleUrl)});
      const child = acquireProfileMaintenanceBinding({ label: "Delegated evaluator" });
      child.assertCurrent();
      console.log(child.delegated ? "DELEGATED" : "UNSAFE-PARENT");
      child.release();
    `)};
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", childSource], {
      env: { ...process.env, ...parent.childEnvironment() },
      encoding: "utf8",
    });
    parent.release();
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    console.log(result.stdout.trim());
  `;
  try {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", childSource], {
      cwd: resolve("."),
      env: {
        ...process.env,
        RANGABOT_RESOURCE_ROOT: resolve("."),
        RANGABOT_DATA_ROOT: paths.root,
      },
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.equal(run.stdout.trim(), "DELEGATED");
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});
