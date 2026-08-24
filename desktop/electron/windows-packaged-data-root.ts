import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export const WINDOWS_INTERNAL_MSIX_PACKAGE_NAME = "RangaBot.InternalCandidate" as const;
export const WINDOWS_INTERNAL_MSIX_PACKAGE_VERSION = "0.1.0.0" as const;
export const WINDOWS_INTERNAL_MSIX_PUBLISHER_ID = "d8tfa9dph86fg" as const;
export const WINDOWS_INTERNAL_MSIX_PACKAGE_FAMILY_NAME =
  `${WINDOWS_INTERNAL_MSIX_PACKAGE_NAME}_${WINDOWS_INTERNAL_MSIX_PUBLISHER_ID}` as const;
export const WINDOWS_INTERNAL_MSIX_PACKAGE_FULL_NAME =
  `${WINDOWS_INTERNAL_MSIX_PACKAGE_NAME}_${WINDOWS_INTERNAL_MSIX_PACKAGE_VERSION}_x64__${WINDOWS_INTERNAL_MSIX_PUBLISHER_ID}` as const;

export type WindowsInternalMsixDataPaths = Readonly<{
  userDataPath: string;
  sessionDataPath: string;
  logsPath: string;
  crashDumpsPath: string;
}>;

function samePath(left: string, right: string, platform: NodeJS.Platform) {
  return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function assertAbsoluteNormalizedPath(path: string, label: string) {
  if (!path || !isAbsolute(path) || resolve(path) !== path) {
    throw new Error(`${label} must be an absolute normalized path.`);
  }
}

function assertDistinctChild(parent: string, child: string, label: string) {
  const traversal = relative(parent, child);
  if (!traversal || traversal === ".." || traversal.startsWith(`..${sep}`) || isAbsolute(traversal)) {
    throw new Error(`${label} must remain inside its package-owned root.`);
  }
}

function requireCanonicalRealEntry(
  path: string,
  label: string,
  platform: NodeJS.Platform,
  kind: "directory" | "file",
) {
  assertAbsoluteNormalizedPath(path, label);
  const root = parse(path).root;
  let cursor = root;
  for (const component of path.slice(root.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    const status = lstatSync(cursor);
    if (status.isSymbolicLink()) throw new Error(`${label} cannot contain symbolic-link or junction components.`);
  }
  const status = lstatSync(path);
  const expectedKind = kind === "directory" ? status.isDirectory() : status.isFile();
  if (status.isSymbolicLink() || !expectedKind) {
    throw new Error(`${label} must be a real ${kind}.`);
  }
  const canonical = realpathSync(path);
  assertAbsoluteNormalizedPath(canonical, label);
  if (!samePath(canonical, path, platform)) throw new Error(`${label} must be canonical and unsymlinked.`);
  return canonical;
}

function requireCanonicalRealDirectory(path: string, label: string, platform: NodeJS.Platform) {
  return requireCanonicalRealEntry(path, label, platform, "directory");
}

function requireCanonicalRealFile(path: string, label: string, platform: NodeJS.Platform) {
  return requireCanonicalRealEntry(path, label, platform, "file");
}

function preparePrivateDirectory(parent: string, name: string, label: string, platform: NodeJS.Platform) {
  const requested = join(parent, name);
  assertDistinctChild(parent, requested, label);
  try {
    mkdirSync(requested, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return requireCanonicalRealDirectory(requested, label, platform);
}

function validateInstalledInternalMsixExecutable(execPath: string | undefined, platform: NodeJS.Platform) {
  if (!execPath) throw new Error("The Windows MSIX executable path is unavailable.");
  const executable = requireCanonicalRealFile(execPath, "Windows MSIX executable", platform);
  if (!samePath(basename(executable), "RangaBot.exe", platform)) {
    throw new Error("The Windows MSIX executable name does not match the sealed application identity.");
  }
  const packageRoot = requireCanonicalRealDirectory(dirname(executable), "Windows MSIX package root", platform);
  if (!samePath(basename(packageRoot), WINDOWS_INTERNAL_MSIX_PACKAGE_FULL_NAME, platform)) {
    throw new Error("The running Windows package full name does not match RangaBot's internal candidate identity.");
  }
  const windowsAppsRoot = requireCanonicalRealDirectory(dirname(packageRoot), "WindowsApps package store", platform);
  if (!samePath(basename(windowsAppsRoot), "WindowsApps", platform)) {
    throw new Error("The internal MSIX executable is not running from the Windows package store.");
  }
}

function resolveTrustedLocalAppData(input: {
  appDataPath?: string;
  localAppDataPath?: string;
  platform: NodeJS.Platform;
}) {
  if (!input.appDataPath) throw new Error("Electron appData is unavailable for Windows package data validation.");
  if (!input.localAppDataPath) {
    throw new Error("Windows LOCALAPPDATA is unavailable for RangaBot's package-owned data root.");
  }
  const roaming = requireCanonicalRealDirectory(input.appDataPath, "Electron appData", input.platform);
  if (!samePath(basename(roaming), "Roaming", input.platform)) {
    throw new Error("Electron appData does not have the required Windows AppData\\Roaming shape.");
  }
  const appDataRoot = requireCanonicalRealDirectory(dirname(roaming), "Windows AppData root", input.platform);
  if (!samePath(basename(appDataRoot), "AppData", input.platform)) {
    throw new Error("Electron appData does not have the required Windows AppData\\Roaming shape.");
  }
  const derivedLocalAppData = requireCanonicalRealDirectory(
    join(appDataRoot, "Local"),
    "OS-derived Windows LOCALAPPDATA",
    input.platform,
  );
  const suppliedLocalAppData = requireCanonicalRealDirectory(
    input.localAppDataPath,
    "Windows LOCALAPPDATA",
    input.platform,
  );
  if (!samePath(derivedLocalAppData, suppliedLocalAppData, input.platform)) {
    throw new Error("Windows LOCALAPPDATA does not match Electron's OS-derived local AppData path.");
  }
  return derivedLocalAppData;
}

/**
 * A full-trust MSIX can fall back to unvirtualized AppData reads. Validate the
 * exact installed package plus its OS-derived LocalState/LocalCache roots
 * before provisioning Electron paths, so startup never reads or migrates the
 * unpackaged `%APPDATA%\\Rangabot` userData tree.
 */
export function prepareWindowsInternalMsixDataPaths(input: {
  platform: NodeJS.Platform;
  windowsStore: boolean;
  isPackaged: boolean;
  appDataPath?: string;
  localAppDataPath?: string;
  execPath?: string;
}): WindowsInternalMsixDataPaths | null {
  if (!input.windowsStore) return null;
  if (input.platform !== "win32" || !input.isPackaged) {
    throw new Error("Electron reported an inconsistent Windows MSIX runtime identity.");
  }
  validateInstalledInternalMsixExecutable(input.execPath, input.platform);
  const localAppData = resolveTrustedLocalAppData(input);
  const packagesRoot = join(localAppData, "Packages");
  assertDistinctChild(localAppData, packagesRoot, "Windows package data root");
  requireCanonicalRealDirectory(packagesRoot, "Windows package data root", input.platform);

  const packageFamilyRoot = join(packagesRoot, WINDOWS_INTERNAL_MSIX_PACKAGE_FAMILY_NAME);
  assertDistinctChild(packagesRoot, packageFamilyRoot, "RangaBot MSIX package-family data root");
  requireCanonicalRealDirectory(packageFamilyRoot, "RangaBot MSIX package-family data root", input.platform);

  const localState = join(packageFamilyRoot, "LocalState");
  assertDistinctChild(packageFamilyRoot, localState, "RangaBot MSIX LocalState");
  const canonicalLocalState = requireCanonicalRealDirectory(localState, "RangaBot MSIX LocalState", input.platform);
  const localCache = join(packageFamilyRoot, "LocalCache");
  assertDistinctChild(packageFamilyRoot, localCache, "RangaBot MSIX LocalCache");
  const canonicalLocalCache = requireCanonicalRealDirectory(localCache, "RangaBot MSIX LocalCache", input.platform);

  // All package and identity checks finish before the first directory write.
  const userDataPath = preparePrivateDirectory(canonicalLocalState, "RangaBot", "RangaBot MSIX userData", input.platform);
  const sessionRoot = preparePrivateDirectory(canonicalLocalCache, "RangaBot", "RangaBot MSIX cache root", input.platform);
  const sessionDataPath = preparePrivateDirectory(sessionRoot, "sessionData", "RangaBot MSIX sessionData", input.platform);
  const logsPath = preparePrivateDirectory(userDataPath, "logs", "RangaBot MSIX logs", input.platform);
  const crashDumpsPath = preparePrivateDirectory(userDataPath, "crashDumps", "RangaBot MSIX crash dumps", input.platform);
  return Object.freeze({ userDataPath, sessionDataPath, logsPath, crashDumpsPath });
}
