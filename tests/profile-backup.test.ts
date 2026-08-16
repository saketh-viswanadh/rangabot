import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProfileBackup, PROFILE_RESTORED_EXTERNAL_REFERENCES, restoreProfileBackup } from "../lib/profile-backup.ts";

const profile = { id: "45b0990a-1df4-4675-ac0e-5b24ee3e4db3", displayName: "Research", type: "personal" as const };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rangabot-profile-backup-"));
  const source = join(root, "source");
  const profiles = join(root, "profiles");
  mkdirSync(join(source, "knowledge", "indexes"), { recursive: true, mode: 0o700 });
  mkdirSync(join(source, "credentials"), { mode: 0o700 });
  mkdirSync(join(source, "models"), { mode: 0o700 });
  mkdirSync(profiles, { mode: 0o700 });
  writeFileSync(join(source, "rangabot.db"), "conversation", { mode: 0o600 });
  writeFileSync(join(source, "knowledge", "indexes", "knowledge.db"), "knowledge", { mode: 0o600 });
  writeFileSync(join(source, "desktop-preferences.json"), "{}", { mode: 0o600 });
  writeFileSync(join(source, "credentials", "secret"), "never", { mode: 0o600 });
  writeFileSync(join(source, "models", "weight"), "never", { mode: 0o600 });
  writeFileSync(join(source, "repositories.json"), JSON.stringify([{ id: "repo-1", name: "Code", path: "/synthetic-fixtures/private-code" }]), { mode: 0o600 });
  writeFileSync(join(source, "datasets.json"), JSON.stringify([{ id: "data-1", name: "Data", path: "/synthetic-fixtures/private.csv" }]), { mode: 0o600 });
  return { root, source, profiles };
}

test("creates an integrity-bound backup and restores content without credentials, weights, or active approvals", () => {
  const { source, profiles } = fixture();
  const backup = createProfileBackup({ profileRoot: source, sourceProfile: profile, now: "2026-08-13T10:00:00.000Z" });
  const target = join(profiles, "restored");
  const receipt = restoreProfileBackup({ bytes: backup, targetRoot: target });
  assert.equal(readFileSync(join(target, "rangabot.db"), "utf8"), "conversation");
  assert.equal(readFileSync(join(target, "knowledge", "indexes", "knowledge.db"), "utf8"), "knowledge");
  assert.throws(() => readFileSync(join(target, "credentials", "secret")));
  assert.throws(() => readFileSync(join(target, "models", "weight")));
  assert.throws(() => readFileSync(join(target, "repositories.json")));
  assert.throws(() => readFileSync(join(target, "datasets.json")));
  const inactive = JSON.parse(readFileSync(join(target, PROFILE_RESTORED_EXTERNAL_REFERENCES), "utf8")) as { status: string; references: Array<{ status: string }> };
  assert.equal(inactive.status, "inactive-reapproval-required");
  assert.equal(inactive.references.length, 2);
  assert.ok(inactive.references.every(({ status }) => status === "inactive-reapproval-required"));
  assert.equal(receipt.restoredFiles, 3);
});

test("rejects tampered content and traversal before creating the target", () => {
  const { source, profiles } = fixture();
  const backup = createProfileBackup({ profileRoot: source, sourceProfile: profile });
  const tampered = Buffer.from(backup);
  const index = tampered.indexOf(Buffer.from("Y29udmVyc2F0aW9u"));
  assert.ok(index >= 0);
  tampered[index] = tampered[index] === 65 ? 66 : 65;
  assert.throws(() => restoreProfileBackup({ bytes: tampered, targetRoot: join(profiles, "tampered") }), /integrity/);
  assert.throws(() => readFileSync(join(profiles, "tampered", "rangabot.db")));

  const parsed = JSON.parse(Buffer.from(backup).toString("utf8")) as { files: Array<{ path: string }>; manifestSha256: string };
  parsed.files[0].path = "../escape";
  assert.throws(() => restoreProfileBackup({ bytes: Buffer.from(JSON.stringify(parsed)), targetRoot: join(profiles, "traversal") }));
  assert.throws(() => readFileSync(join(profiles, "traversal")));
});

test("rejects symbolic links and hard-linked or changing source shapes", () => {
  const { source } = fixture();
  symlinkSync("rangabot.db", join(source, "linked.db"));
  assert.throws(() => createProfileBackup({ profileRoot: source, sourceProfile: profile }), /symbolic/);
});

test("rolls back a staged restore after a write failure", () => {
  const { source, profiles } = fixture();
  const backup = createProfileBackup({ profileRoot: source, sourceProfile: profile });
  const target = join(profiles, "low-space");
  let writes = 0;
  assert.throws(() => restoreProfileBackup({
    bytes: backup,
    targetRoot: target,
    writeFile: (path, bytes) => {
      writes += 1;
      if (writes === 2) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
    },
  }), /disk full/);
  assert.throws(() => readFileSync(target));
});
