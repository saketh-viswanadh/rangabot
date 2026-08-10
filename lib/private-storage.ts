import {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const privateDirectoryMode = 0o700;
export const privateFileMode = 0o600;

export class UnsafePrivateStoragePathError extends Error {
  constructor(message = "Private storage path contains a symbolic link.") {
    super(message);
    this.name = "UnsafePrivateStoragePathError";
  }
}

export type PrivateStorageOptions = { trustedRoot?: string };

export function supportsPosixPermissions(platform = process.platform) {
  return platform !== "win32";
}

function requireDirectory(path: string) {
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error("Private storage directory must be a real local directory.");
  }
}

function requireRegularFile(path: string) {
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new Error("Private storage file must be a regular local file.");
  }
}

function pathIsWithin(root: string, path: string) {
  const child = relative(root, path);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

/**
 * Chooses an explicit trust boundary without walking above it. Rangabot's
 * managed state lives below the process working directory; deterministic test
 * and worker state may live below the operating-system temp directory. Callers
 * using another location must name their trusted root explicitly.
 */
function resolveTrustedRoot(path: string, requestedRoot?: string) {
  const target = resolve(/* turbopackIgnore: true */ path);
  const candidates = requestedRoot === undefined
    ? [
      resolve(/* turbopackIgnore: true */ process.cwd()),
      resolve(/* turbopackIgnore: true */ tmpdir()),
    ]
    : [resolve(/* turbopackIgnore: true */ requestedRoot)];
  const trustedRoot = candidates
    .filter((candidate) => pathIsWithin(candidate, target))
    .sort((left, right) => right.length - left.length)[0];
  if (!trustedRoot) {
    throw new UnsafePrivateStoragePathError("Private storage outside Rangabot requires an explicit trusted root.");
  }
  let rootStatus;
  try { rootStatus = lstatSync(trustedRoot); }
  catch {
    throw new UnsafePrivateStoragePathError("Private storage trusted root must be an existing local directory.");
  }
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
    throw new UnsafePrivateStoragePathError("Private storage trusted root must be a real local directory.");
  }
  return trustedRoot;
}

/**
 * Checks every existing component below the trusted root before a filesystem
 * operation. The root itself is checked, but normal system aliases above that
 * explicit boundary (for example macOS /var -> /private/var) are intentionally
 * outside the app-managed path.
 */
function assertSafePrivatePath(path: string, trustedRoot: string, includeTarget = true) {
  const target = resolve(/* turbopackIgnore: true */ path);
  if (!pathIsWithin(trustedRoot, target)) {
    throw new UnsafePrivateStoragePathError("Private storage path escapes its trusted root.");
  }
  const remainder = relative(trustedRoot, target);
  let cursor = trustedRoot;
  const components = remainder ? remainder.split(sep) : [];
  if (!includeTarget) components.pop();
  for (const component of components) {
    cursor = resolve(/* turbopackIgnore: true */ cursor, component);
    let status;
    try { status = lstatSync(cursor); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (status.isSymbolicLink()) {
      throw new UnsafePrivateStoragePathError();
    }
    if (cursor !== target && !status.isDirectory()) {
      throw new UnsafePrivateStoragePathError("Private storage ancestor must be a real local directory.");
    }
  }
}

function sameEntry(left: Stats, right: Stats) {
  return left.dev === right.dev && left.ino === right.ino;
}

function hardenVerifiedEntry(path: string, status: Stats, expected: "file" | "directory") {
  if (!supportsPosixPermissions()) return;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    const expectedType = expected === "file" ? opened.isFile() : opened.isDirectory();
    if (!expectedType || !sameEntry(status, opened)) {
      throw new UnsafePrivateStoragePathError("Private storage entry changed while it was being secured.");
    }
    fchmodSync(descriptor, expected === "file" ? privateFileMode : privateDirectoryMode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new UnsafePrivateStoragePathError();
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function hardenExistingPrivateFile(path: string, options: PrivateStorageOptions = {}) {
  const trustedRoot = resolveTrustedRoot(path, options.trustedRoot);
  assertSafePrivatePath(path, trustedRoot);
  let status;
  try {
    status = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (status.isSymbolicLink() || !status.isFile()) throw new Error("Private storage file must be a regular local file.");
  hardenVerifiedEntry(path, status, "file");
}

export function ensurePrivateDirectory(path: string, options: PrivateStorageOptions = {}) {
  const trustedRoot = resolveTrustedRoot(path, options.trustedRoot);
  assertSafePrivatePath(path, trustedRoot);
  mkdirSync(path, { recursive: true, mode: privateDirectoryMode });
  assertSafePrivatePath(path, trustedRoot);
  requireDirectory(path);
  hardenVerifiedEntry(path, lstatSync(path), "directory");
}

export function ensurePrivateFile(path: string, options: PrivateStorageOptions = {}) {
  const trustedRoot = resolveTrustedRoot(path, options.trustedRoot);
  assertSafePrivatePath(path, trustedRoot);
  ensurePrivateDirectory(dirname(path), { trustedRoot });
  assertSafePrivatePath(path, trustedRoot);
  const noFollow = supportsPosixPermissions() ? constants.O_NOFOLLOW : 0;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, privateFileMode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error("Private storage file must be a regular local file.");
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!supportsPosixPermissions()) requireRegularFile(path);
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
  }
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) throw new Error("Private storage file must be a regular local file.");
    const status = lstatSync(path);
    if (status.isSymbolicLink() || !status.isFile() || !sameEntry(status, opened)) {
      throw new UnsafePrivateStoragePathError("Private storage file changed while it was being secured.");
    }
    if (supportsPosixPermissions()) fchmodSync(descriptor, privateFileMode);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Atomically replaces a private text file without ever creating a
 * group/world-readable intermediate file. The temporary file lives beside the
 * target so the final rename stays on the same filesystem.
 */
export function writePrivateTextFileAtomic(path: string, content: string, options: PrivateStorageOptions = {}) {
  const trustedRoot = resolveTrustedRoot(path, options.trustedRoot);
  assertSafePrivatePath(path, trustedRoot);
  ensurePrivateDirectory(dirname(path), { trustedRoot });
  hardenExistingPrivateFile(path, { trustedRoot });
  const temporary = resolve(/* turbopackIgnore: true */ dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    const noFollow = supportsPosixPermissions() ? constants.O_NOFOLLOW : 0;
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      privateFileMode,
    );
    writeFileSync(descriptor, content, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    assertSafePrivatePath(temporary, trustedRoot);
    hardenExistingPrivateFile(temporary, { trustedRoot });
    assertSafePrivatePath(path, trustedRoot);
    renameSync(temporary, path);
    assertSafePrivatePath(path, trustedRoot);
    requireRegularFile(path);
    hardenExistingPrivateFile(path, { trustedRoot });
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* Preserve the original error. */ }
    }
    try { unlinkSync(temporary); } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        // Cleanup failure must not hide the write failure.
      }
    }
    throw error;
  }
}

export function writePrivateJsonFileAtomic(path: string, value: unknown, options: PrivateStorageOptions = {}) {
  writePrivateTextFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, options);
}

export function preparePrivateSqliteStorage(path: string, options: PrivateStorageOptions = {}) {
  const trustedRoot = resolveTrustedRoot(path, options.trustedRoot);
  ensurePrivateFile(path, { trustedRoot });
  hardenPrivateSqliteFiles(path, { trustedRoot });
}

export function hardenPrivateSqliteFiles(path: string, options: PrivateStorageOptions = {}) {
  const trustedRoot = resolveTrustedRoot(path, options.trustedRoot);
  for (const candidate of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    hardenExistingPrivateFile(candidate, { trustedRoot });
  }
}

export type PrivateTreeRepair = { directories: number; files: number };
export type PrivateTreeRepairOptions = PrivateStorageOptions & { skipNestedSymlinks?: boolean };

/**
 * Repairs permissions only inside an explicitly app-managed tree. Symlinks and
 * special files are rejected so this helper can never follow an approval into
 * an external dataset or repository.
 */
function hardenPrivateTreeEntry(path: string, trustedRoot: string, options: PrivateTreeRepairOptions, depth: number): PrivateTreeRepair {
  assertSafePrivatePath(path, trustedRoot, false);
  let status;
  try { status = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { directories: 0, files: 0 };
    throw error;
  }
  if (status.isSymbolicLink()) {
    if (depth > 0 && options.skipNestedSymlinks) return { directories: 0, files: 0 };
    throw new UnsafePrivateStoragePathError("Private storage repair refuses symbolic links.");
  }
  if (status.isFile()) {
    hardenVerifiedEntry(path, status, "file");
    return { directories: 0, files: 1 };
  }
  if (!status.isDirectory()) throw new Error("Private storage repair accepts only regular files and directories.");
  hardenVerifiedEntry(path, status, "directory");
  return readdirSync(path, { withFileTypes: true }).reduce<PrivateTreeRepair>((total, entry) => {
    const repaired = hardenPrivateTreeEntry(
      resolve(/* turbopackIgnore: true */ path, entry.name),
      trustedRoot,
      options,
      depth + 1,
    );
    return { directories: total.directories + repaired.directories, files: total.files + repaired.files };
  }, { directories: 1, files: 0 });
}

export function hardenPrivateTree(path: string, options: PrivateTreeRepairOptions = {}): PrivateTreeRepair {
  const trustedRoot = resolveTrustedRoot(path, options.trustedRoot);
  return hardenPrivateTreeEntry(path, trustedRoot, options, 0);
}
