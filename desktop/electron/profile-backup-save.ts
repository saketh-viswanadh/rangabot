import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { BrowserWindow, Dialog } from "electron";
import { inspectProfileBackup } from "../../lib/profile-backup.ts";

export const PROFILE_BACKUP_SAVE_CHANNEL = "rangabot:save-profile-backup";
export const MAX_DESKTOP_PROFILE_BACKUP_BYTES = 512 * 1024 * 1024;

export type ProfileBackupSaveRequest = Readonly<{
  filename: string;
  bytes: Uint8Array;
}>;

export type ProfileBackupSaveResult = Readonly<{
  status: "saved" | "cancelled";
}>;

function requireRequest(value: unknown): ProfileBackupSaveRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The profile backup save request is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "bytes,filename"
    || typeof record.filename !== "string"
    || !/^RangaBot-[A-Za-z0-9._-]{1,96}-profile-backup\.json$/.test(record.filename)
    || basename(record.filename) !== record.filename
    || !(record.bytes instanceof Uint8Array)
    || record.bytes.byteLength === 0
    || record.bytes.byteLength > MAX_DESKTOP_PROFILE_BACKUP_BYTES) {
    throw new Error("The profile backup save request is invalid.");
  }
  const bytes = new Uint8Array(record.bytes);
  inspectProfileBackup(bytes);
  return Object.freeze({ filename: record.filename, bytes });
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameEntry(left: Stats, right: Stats) {
  return left.dev === right.dev && left.ino === right.ino;
}

function hashExactFile(path: string, expected: Stats) {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !sameEntry(opened, expected) || opened.nlink < 1 || opened.size !== expected.size) {
      throw new Error("The profile backup file changed during verification.");
    }
    const digest = sha256(readFileSync(descriptor));
    const after = fstatSync(descriptor);
    if (!sameEntry(after, expected) || after.size !== expected.size) {
      throw new Error("The profile backup file changed during verification.");
    }
    return digest;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function syncDirectory(path: string) {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    if (!fstatSync(descriptor).isDirectory()) throw new Error("The selected backup directory is invalid.");
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function saveNewPrivateFile(
  path: string,
  bytes: Uint8Array,
  writeBytes: (descriptor: number, value: Uint8Array) => void = (descriptor, value) => writeFileSync(descriptor, value),
) {
  const parent = realpathSync(dirname(path));
  const selectedName = basename(path);
  if (!selectedName.endsWith(".json") || Buffer.byteLength(selectedName, "utf8") > 240 || /[\0/\\]/u.test(selectedName)) {
    throw new Error("Choose a bounded JSON filename for the local profile backup.");
  }
  const candidate = join(parent, selectedName);
  const temporary = join(parent, `.${selectedName}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  let temporaryIdentity: Stats | undefined;
  let published = false;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
      0o600,
    );
    if (process.platform !== "win32") fchmodSync(descriptor, 0o600);
    writeBytes(descriptor, bytes);
    fsyncSync(descriptor);
    const written = fstatSync(descriptor);
    if (!written.isFile() || written.nlink !== 1 || written.size !== bytes.byteLength) {
      throw new Error("The profile backup was not written completely.");
    }
    closeSync(descriptor);
    descriptor = undefined;
    temporaryIdentity = lstatSync(temporary);
    if (temporaryIdentity.isSymbolicLink() || !temporaryIdentity.isFile() || temporaryIdentity.nlink !== 1
      || hashExactFile(temporary, temporaryIdentity) !== sha256(bytes)) {
      throw new Error("The profile backup failed its local integrity check.");
    }
    linkSync(temporary, candidate);
    published = true;
    unlinkSync(temporary);
    const finalStatus = lstatSync(candidate);
    if (!sameEntry(temporaryIdentity, finalStatus) || finalStatus.nlink !== 1
      || hashExactFile(candidate, finalStatus) !== sha256(bytes)) {
      throw new Error("The published profile backup failed its local integrity check.");
    }
    syncDirectory(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("That file already exists. Choose a new backup filename so no file is overwritten.");
    }
    if (published && temporaryIdentity) {
      try {
        const status = lstatSync(candidate);
        if (sameEntry(status, temporaryIdentity)) unlinkSync(candidate);
      } catch { /* Never remove an unrecognized destination. */ }
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch { /* The private temporary may not exist. */ }
  }
}

export async function saveProfileBackupWithDialog(input: {
  request: unknown;
  window: BrowserWindow;
  nativeDialog?: Pick<Dialog, "showSaveDialog">;
  writeBytes?: (descriptor: number, value: Uint8Array) => void;
}) : Promise<ProfileBackupSaveResult> {
  const request = requireRequest(input.request);
  const result = await (input.nativeDialog ?? (await import("electron")).dialog).showSaveDialog(input.window, {
    title: "Save RangaBot profile backup",
    defaultPath: request.filename,
    buttonLabel: "Save backup",
    filters: [{ name: "RangaBot profile backup", extensions: ["json"] }],
    properties: ["createDirectory", "showOverwriteConfirmation"],
  });
  if (result.canceled || !result.filePath) return Object.freeze({ status: "cancelled" });
  saveNewPrivateFile(result.filePath, request.bytes, input.writeBytes);
  return Object.freeze({ status: "saved" });
}
