import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { App } from "electron";

const BOOKMARKS_FILE = "mac-app-store-security-scoped-bookmarks.json";
const MAXIMUM_BOOKMARKS = 256;
const MAXIMUM_BOOKMARK_BYTES = 64 * 1024;

type BookmarkRecord = Readonly<{ path: string; bookmark: string }>;

export function isMacAppStoreRuntime(value: unknown = (process as NodeJS.Process & { mas?: unknown }).mas) {
  return value === true;
}

function parseBookmarkRecords(value: unknown): BookmarkRecord[] {
  if (!Array.isArray(value) || value.length > MAXIMUM_BOOKMARKS) {
    throw new Error("Rangabot's Mac App Store file permissions are invalid.");
  }
  const paths = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Rangabot's Mac App Store file permissions are invalid.");
    }
    const record = entry as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== "bookmark,path"
      || typeof record.path !== "string" || !isAbsolute(record.path) || resolve(record.path) !== record.path
      || typeof record.bookmark !== "string" || record.bookmark.length === 0
      || Buffer.byteLength(record.bookmark, "base64") > MAXIMUM_BOOKMARK_BYTES
      || Buffer.from(record.bookmark, "base64").toString("base64") !== record.bookmark
      || paths.has(record.path)) {
      throw new Error("Rangabot's Mac App Store file permissions are invalid.");
    }
    paths.add(record.path);
    return Object.freeze({ path: record.path, bookmark: record.bookmark });
  });
}

function bookmarkFile(userDataPath: string) {
  if (!isAbsolute(userDataPath) || resolve(userDataPath) !== userDataPath) {
    throw new Error("The Mac App Store user-data path is invalid.");
  }
  mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
  const status = lstatSync(userDataPath);
  if (status.isSymbolicLink() || !status.isDirectory() || realpathSync(userDataPath) !== userDataPath) {
    throw new Error("The Mac App Store user-data path must be a real private directory.");
  }
  chmodSync(userDataPath, 0o700);
  return join(userDataPath, BOOKMARKS_FILE);
}

function readBookmarks(userDataPath: string) {
  const path = bookmarkFile(userDataPath);
  if (!existsSync(path)) return [];
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isFile() || status.size > 24 * 1024 * 1024) {
    throw new Error("Rangabot's Mac App Store file permissions are not a safe private file.");
  }
  return parseBookmarkRecords(JSON.parse(readFileSync(path, "utf8")));
}

function writeBookmarks(userDataPath: string, records: readonly BookmarkRecord[]) {
  const path = bookmarkFile(userDataPath);
  if (existsSync(path)) {
    const current = lstatSync(path);
    if (current.isSymbolicLink() || !current.isFile()) {
      throw new Error("Rangabot's Mac App Store file permissions destination is unsafe.");
    }
  }
  const temporary = join(dirname(path), `.${BOOKMARKS_FILE}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(records, null, 2)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch { /* The owned temporary may already be renamed. */ }
  }
}

export type MacSecurityScopedAccess = Readonly<{
  paths: readonly string[];
  stop(): void;
}>;

function startBookmarks(
  app: Pick<App, "startAccessingSecurityScopedResource">,
  records: readonly BookmarkRecord[],
): MacSecurityScopedAccess {
  const stops: Array<() => void> = [];
  try {
    for (const record of records) {
      const stop = app.startAccessingSecurityScopedResource(record.bookmark);
      stops.push(() => stop());
    }
  } catch (error) {
    for (const stop of stops.reverse()) stop();
    throw error;
  }
  let stopped = false;
  return Object.freeze({
    paths: Object.freeze(records.map((record) => record.path)),
    stop() {
      if (stopped) return;
      stopped = true;
      for (const stop of stops.reverse()) stop();
    },
  });
}

export function restoreMacSecurityScopedAccess(input: {
  app: Pick<App, "startAccessingSecurityScopedResource">;
  userDataPath: string;
}): MacSecurityScopedAccess {
  return startBookmarks(input.app, readBookmarks(input.userDataPath));
}

export function rememberMacSecurityScopedAccess(input: {
  app: Pick<App, "startAccessingSecurityScopedResource">;
  userDataPath: string;
  paths: readonly string[];
  bookmarks: readonly string[];
}): MacSecurityScopedAccess {
  if (input.paths.length === 0 || input.paths.length !== input.bookmarks.length) {
    throw new Error("The Mac App Store file selection did not include matching security-scoped permissions.");
  }
  const selected = parseBookmarkRecords(input.paths.map((path, index) => ({ path, bookmark: input.bookmarks[index] })));
  const access = startBookmarks(input.app, selected);
  try {
    const merged = new Map(readBookmarks(input.userDataPath).map((record) => [record.path, record]));
    for (const record of selected) merged.set(record.path, record);
    const records = [...merged.values()].sort((left, right) => left.path.localeCompare(right.path));
    if (records.length > MAXIMUM_BOOKMARKS) throw new Error("Rangabot has reached its saved file-permission limit.");
    writeBookmarks(input.userDataPath, records);
    return access;
  } catch (error) {
    access.stop();
    throw error;
  }
}
