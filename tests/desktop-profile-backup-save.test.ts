import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProfileBackup } from "../lib/profile-backup.ts";
import {
  MAX_DESKTOP_PROFILE_BACKUP_BYTES,
  PROFILE_BACKUP_SAVE_CHANNEL,
  saveProfileBackupWithDialog,
} from "../desktop/electron/profile-backup-save.ts";

function syntheticBackup(root: string) {
  const profileRoot = join(root, "profile");
  mkdirSync(profileRoot, { mode: 0o700 });
  return createProfileBackup({
    profileRoot,
    sourceProfile: {
      id: "10000000-0000-4000-8000-000000000001",
      displayName: "Synthetic",
      type: "testing",
    },
  });
}

test("desktop profile backup Save As validates the envelope and writes only a new chosen file", async () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-desktop-profile-backup-"));
  const target = join(root, "RangaBot-Testing-profile-backup.json");
  try {
    const bytes = syntheticBackup(root);
    const result = await saveProfileBackupWithDialog({
      request: { filename: "RangaBot-Testing-profile-backup.json", bytes },
      window: {} as never,
      nativeDialog: { showSaveDialog: async () => ({ canceled: false, filePath: target }) } as never,
    });
    assert.deepEqual(result, { status: "saved" });
    assert.deepEqual(readFileSync(target), Buffer.from(bytes));
    await assert.rejects(saveProfileBackupWithDialog({
      request: { filename: "RangaBot-Testing-profile-backup.json", bytes },
      window: {} as never,
      nativeDialog: { showSaveDialog: async () => ({ canceled: false, filePath: target }) } as never,
    }), /already exists/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("desktop profile backup bridge rejects malformed, oversized, cancelled, and path-like requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-desktop-profile-backup-reject-"));
  try {
    const bytes = syntheticBackup(root);
    const cancelled = await saveProfileBackupWithDialog({
      request: { filename: "RangaBot-Testing-profile-backup.json", bytes },
      window: {} as never,
      nativeDialog: { showSaveDialog: async () => ({ canceled: true }) } as never,
    });
    assert.deepEqual(cancelled, { status: "cancelled" });
    assert.equal(existsSync(join(root, "RangaBot-Testing-profile-backup.json")), false);
    for (const request of [
      { filename: "../escape.json", bytes },
      { filename: "RangaBot-Testing-profile-backup.json", bytes: new Uint8Array([1, 2, 3]) },
      { filename: "RangaBot-Testing-profile-backup.json", bytes: new Uint8Array(MAX_DESKTOP_PROFILE_BACKUP_BYTES + 1) },
    ]) {
      await assert.rejects(saveProfileBackupWithDialog({
        request,
        window: {} as never,
        nativeDialog: { showSaveDialog: async () => ({ canceled: true }) } as never,
      }));
    }
    assert.equal(PROFILE_BACKUP_SAVE_CHANNEL, "rangabot:save-profile-backup");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("desktop profile backup publication removes partial bytes after a low-space failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-desktop-profile-backup-partial-"));
  const target = join(root, "RangaBot-Testing-profile-backup.json");
  try {
    const bytes = syntheticBackup(root);
    await assert.rejects(saveProfileBackupWithDialog({
      request: { filename: "RangaBot-Testing-profile-backup.json", bytes },
      window: {} as never,
      nativeDialog: { showSaveDialog: async () => ({ canceled: false, filePath: target }) } as never,
      writeBytes(descriptor, value) {
        writeFileSync(descriptor, value.subarray(0, Math.max(1, Math.floor(value.byteLength / 2))));
        throw Object.assign(new Error("synthetic low space"), { code: "ENOSPC" });
      },
    }), /synthetic low space/);
    assert.equal(existsSync(target), false);
    assert.deepEqual(readdirSync(root).filter((name) => name.includes(".tmp")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sealed verification desktop never installs the external Save As bridge", () => {
  const main = readFileSync("desktop/electron/main.ts", "utf8");
  assert.match(main, /if \(!input\.verificationPolicy\) \{[\s\S]*?ipcMain\.handle\(PROFILE_BACKUP_SAVE_CHANNEL/);
});
