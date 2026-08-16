import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  type Stats,
} from "node:fs";

export function supportsDirectoryFsync(platform = process.platform) {
  return platform !== "win32";
}

function sameEntry(left: Stats, right: Stats) {
  return left.dev === right.dev && left.ino === right.ino;
}

function directoryFlags() {
  return constants.O_RDONLY
    | (supportsDirectoryFsync() ? constants.O_NOFOLLOW : 0)
    | (supportsDirectoryFsync() ? constants.O_DIRECTORY : 0);
}

/**
 * Verifies an exact real directory before crossing a metadata durability
 * boundary. POSIX supports fsync on directory descriptors. Windows does not;
 * regular-file fsyncs and atomic publication remain strict there while this
 * helper still verifies that the selected directory did not change.
 */
export function syncDirectoryMetadata(path: string, label: string) {
  let descriptor: number | undefined;
  try {
    const before = lstatSync(path);
    if (before.isSymbolicLink() || !before.isDirectory() || before.nlink < 1) {
      throw new Error(`${label} must be a real local directory.`);
    }
    descriptor = openSync(path, directoryFlags());
    const opened = fstatSync(descriptor);
    const current = lstatSync(path);
    if (!opened.isDirectory()
      || opened.nlink < 1
      || current.isSymbolicLink()
      || !current.isDirectory()
      || !sameEntry(before, opened)
      || !sameEntry(opened, current)) {
      throw new Error(`${label} changed while its durability boundary was being verified.`);
    }
    if (supportsDirectoryFsync()) fsyncSync(descriptor);
    const after = fstatSync(descriptor);
    const finalPath = lstatSync(path);
    if (!after.isDirectory()
      || after.nlink < 1
      || finalPath.isSymbolicLink()
      || !finalPath.isDirectory()
      || !sameEntry(opened, after)
      || !sameEntry(after, finalPath)) {
      throw new Error(`${label} changed while its durability boundary was being synchronized.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`${label} must not be a symbolic link.`);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
