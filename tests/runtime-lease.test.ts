import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireRuntimeLease,
  RuntimeLeaseError,
  type ProcessState,
} from "../lib/runtime-lease.ts";
import { privateFileMode, supportsPosixPermissions } from "../lib/private-storage.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rangabot-runtime-lease-"));
  return { root, path: join(root, "private", "runtime.lock") };
}

test("publishes one private exclusive lease and releases only its own token", () => {
  const { root, path } = fixture();
  try {
    const first = acquireRuntimeLease({ path, role: "app", ownerPid: 101, inspectProcess: () => "alive", token: () => "a".repeat(43) });
    assert.equal(existsSync(path), true);
    if (supportsPosixPermissions()) assert.equal(statSync(path).mode & 0o777, privateFileMode);

    assert.throws(
      () => acquireRuntimeLease({ path, role: "maintenance", ownerPid: 202, inspectProcess: () => "alive" }),
      (error) => error instanceof RuntimeLeaseError && error.code === "active",
    );
    assert.equal(first.release(), true);
    assert.equal(first.release(), false);
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reclaims a fully written stale PID record but never removes an active replacement", () => {
  const { root, path } = fixture();
  try {
    const stale = acquireRuntimeLease({ path, role: "app", ownerPid: 101, inspectProcess: () => "alive", token: () => "s".repeat(43) });
    const replacement = acquireRuntimeLease({
      path,
      role: "maintenance",
      ownerPid: 202,
      inspectProcess: () => "dead",
      token: () => "r".repeat(43),
    });
    assert.equal(stale.release(), false);
    assert.equal(existsSync(path), true);
    assert.match(readFileSync(path, "utf8"), /"ownerPid":202/);
    assert.equal(replacement.release(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a live or uninspectable supervised runtime PID keeps an orphaned owner lease active", () => {
  const { root, path } = fixture();
  try {
    const owner = acquireRuntimeLease({ path, role: "app", ownerPid: 101, inspectProcess: () => "alive" });
    owner.registerRuntimeProcess(303);

    for (const runtimeState of ["alive", "unknown"] satisfies ProcessState[]) {
      assert.throws(
        () => acquireRuntimeLease({
          path,
          role: "maintenance",
          ownerPid: 202,
          inspectProcess: (pid) => pid === 101 ? "dead" : runtimeState,
        }),
        (error) => error instanceof RuntimeLeaseError && error.code === "active",
      );
    }
    assert.equal(owner.release(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed on malformed lease content without deleting it", () => {
  const { root, path } = fixture();
  try {
    const parent = join(root, "private");
    const seed = acquireRuntimeLease({ path, role: "app", inspectProcess: () => "alive" });
    seed.release();
    writeFileSync(path, "not-json\n", { mode: 0o600 });

    assert.throws(
      () => acquireRuntimeLease({ path, role: "maintenance", inspectProcess: () => "dead" }),
      (error) => error instanceof RuntimeLeaseError && error.code === "invalid",
    );
    assert.equal(readFileSync(path, "utf8"), "not-json\n");
    assert.equal(existsSync(parent), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("both local launchers hold the lease for the supervised Next process lifecycle", () => {
  for (const script of ["scripts/start-dev.ts", "scripts/start-server.ts"]) {
    const source = readFileSync(join(process.cwd(), script), "utf8");
    assert.match(source, /acquireRuntimeLease\(\{ role: "app" \}\)/);
    assert.match(source, /runtimeLease\.registerRuntimeProcess\(child\.pid\)/);
    assert.match(source, /child\.once\("exit",[\s\S]*runtimeLease\.release\(\)/);
    assert.match(source, /child\.exitCode !== null \|\| child\.signalCode !== null[\s\S]*runtimeLease\.release\(\)/);
  }
});
