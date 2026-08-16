import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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

function leaseRecord(ownerPid: number, token: string) {
  return {
    version: 1,
    role: "app",
    ownerPid,
    token,
    createdAt: "2026-08-13T00:00:00.000Z",
  } as const;
}

function leaseClaimNames(path: string) {
  return readdirSync(join(path, ".."))
    .filter((name) => name.startsWith(".runtime.lock.claim-"));
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

test("stale reclamation never unlinks a replacement published after inode inspection", () => {
  const { root, path } = fixture();
  const staleToken = "s".repeat(43);
  const replacementToken = "p".repeat(43);
  let injected = false;
  try {
    acquireRuntimeLease({
      path,
      role: "app",
      ownerPid: 101,
      inspectProcess: () => "alive",
      token: () => staleToken,
    });

    assert.throws(
      () => acquireRuntimeLease({
        path,
        role: "maintenance",
        ownerPid: 202,
        inspectProcess: (pid) => pid === 101 ? "dead" : "alive",
        token: () => "n".repeat(43),
        onLeaseClaimForTests({ path: claimedPath, expectedToken }) {
          if (injected || expectedToken !== staleToken) return;
          injected = true;
          unlinkSync(claimedPath);
          writeFileSync(
            claimedPath,
            `${JSON.stringify(leaseRecord(303, replacementToken))}\n`,
            { mode: 0o600 },
          );
        },
      }),
      (error) => error instanceof RuntimeLeaseError && error.code === "active",
    );

    assert.equal(injected, true);
    assert.equal(readFileSync(path, "utf8"), `${JSON.stringify(leaseRecord(303, replacementToken))}\n`);
    assert.deepEqual(leaseClaimNames(path), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("competing stale claims are normalized before one bounded reclaimer proceeds", () => {
  const { root, path } = fixture();
  const staleToken = "s".repeat(43);
  let competingClaim = "";
  try {
    acquireRuntimeLease({
      path,
      role: "app",
      ownerPid: 101,
      inspectProcess: () => "alive",
      token: () => staleToken,
    });

    const replacement = acquireRuntimeLease({
      path,
      role: "maintenance",
      ownerPid: 202,
      inspectProcess: () => "dead",
      token: () => "r".repeat(43),
      onLeaseClaimForTests({ path: claimedPath, expectedToken }) {
        if (competingClaim || expectedToken !== staleToken) return;
        competingClaim = join(
          claimedPath,
          "..",
          `.runtime.lock.claim-${"c".repeat(48)}.tmp`,
        );
        linkSync(claimedPath, competingClaim);
      },
    });

    assert.notEqual(competingClaim, "");
    assert.equal(existsSync(competingClaim), false);
    assert.deepEqual(leaseClaimNames(path), []);
    assert.match(readFileSync(path, "utf8"), /"ownerPid":202/);
    assert.equal(replacement.release(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release never unlinks a replacement published after inode inspection", () => {
  const { root, path } = fixture();
  const ownerToken = "o".repeat(43);
  const replacementToken = "p".repeat(43);
  let injected = false;
  try {
    const lease = acquireRuntimeLease({
      path,
      role: "app",
      ownerPid: 101,
      inspectProcess: () => "alive",
      token: () => ownerToken,
      onLeaseClaimForTests({ path: claimedPath, expectedToken }) {
        if (injected || expectedToken !== ownerToken) return;
        injected = true;
        unlinkSync(claimedPath);
        writeFileSync(
          claimedPath,
          `${JSON.stringify(leaseRecord(303, replacementToken))}\n`,
          { mode: 0o600 },
        );
      },
    });

    assert.equal(lease.release(), false);
    assert.equal(injected, true);
    assert.equal(readFileSync(path, "utf8"), `${JSON.stringify(leaseRecord(303, replacementToken))}\n`);
    assert.deepEqual(leaseClaimNames(path), []);
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
