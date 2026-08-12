import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export const DESKTOP_FINDER_VERIFICATION_BUILD_PROFILE = "finder-synthetic-v1" as const;
export const DESKTOP_FINDER_VERIFICATION_PROFILE_ID = "rbv-arm64-20260812-v1" as const;
export const DESKTOP_FINDER_VERIFICATION_RELATIVE_PATH =
  `RangaBot Verification/${DESKTOP_FINDER_VERIFICATION_PROFILE_ID}` as const;
export const DESKTOP_VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS = "deny" as const;
export const DESKTOP_VERIFICATION_LOCAL_MODEL_POLICY = "disabled" as const;

export type DesktopNormalLaunchProfile = Readonly<{ kind: "normal" }>;
export type DesktopFinderVerificationLaunchProfile = Readonly<{
  kind: typeof DESKTOP_FINDER_VERIFICATION_BUILD_PROFILE;
  profileId: typeof DESKTOP_FINDER_VERIFICATION_PROFILE_ID;
  applicationSupportRelativePath: typeof DESKTOP_FINDER_VERIFICATION_RELATIVE_PATH;
  capsuleMarkerSha256: string;
  externalFilesystemAccess: typeof DESKTOP_VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS;
  localModelPolicy: typeof DESKTOP_VERIFICATION_LOCAL_MODEL_POLICY;
}>;
export type DesktopLaunchProfile = DesktopNormalLaunchProfile | DesktopFinderVerificationLaunchProfile;

export const NORMAL_DESKTOP_LAUNCH_PROFILE: DesktopNormalLaunchProfile = Object.freeze({ kind: "normal" });

function capsuleMarkerValue() {
  return {
    schemaVersion: 1,
    profileId: DESKTOP_FINDER_VERIFICATION_PROFILE_ID,
    applicationSupportRelativePath: DESKTOP_FINDER_VERIFICATION_RELATIVE_PATH,
  } as const;
}

export function finderVerificationCapsuleMarkerBytes() {
  return `${JSON.stringify(capsuleMarkerValue())}\n`;
}

const capsuleMarkerSha256 = createHash("sha256")
  .update(finderVerificationCapsuleMarkerBytes())
  .digest("hex");

export const FINDER_VERIFICATION_DESKTOP_LAUNCH_PROFILE: DesktopFinderVerificationLaunchProfile = Object.freeze({
  kind: DESKTOP_FINDER_VERIFICATION_BUILD_PROFILE,
  profileId: DESKTOP_FINDER_VERIFICATION_PROFILE_ID,
  applicationSupportRelativePath: DESKTOP_FINDER_VERIFICATION_RELATIVE_PATH,
  capsuleMarkerSha256,
  externalFilesystemAccess: DESKTOP_VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS,
  localModelPolicy: DESKTOP_VERIFICATION_LOCAL_MODEL_POLICY,
});

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function parseDesktopLaunchProfile(value: unknown): DesktopLaunchProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind === "normal" && exactKeys(record, ["kind"])) return NORMAL_DESKTOP_LAUNCH_PROFILE;
  const expected = FINDER_VERIFICATION_DESKTOP_LAUNCH_PROFILE;
  if (!exactKeys(record, [
    "kind",
    "profileId",
    "applicationSupportRelativePath",
    "capsuleMarkerSha256",
    "externalFilesystemAccess",
    "localModelPolicy",
  ])
    || record.kind !== expected.kind
    || record.profileId !== expected.profileId
    || record.applicationSupportRelativePath !== expected.applicationSupportRelativePath
    || record.capsuleMarkerSha256 !== expected.capsuleMarkerSha256
    || record.externalFilesystemAccess !== expected.externalFilesystemAccess
    || record.localModelPolicy !== expected.localModelPolicy) return null;
  return expected;
}

export function desktopLaunchProfileForBuild(value: string | undefined): DesktopLaunchProfile {
  if (value === undefined || value === "") return NORMAL_DESKTOP_LAUNCH_PROFILE;
  if (value === DESKTOP_FINDER_VERIFICATION_BUILD_PROFILE) return FINDER_VERIFICATION_DESKTOP_LAUNCH_PROFILE;
  throw new Error("The desktop build profile is not recognized.");
}

export type DesktopFinderVerificationCapsule = Readonly<{
  capsuleRoot: string;
  userDataPath: string;
  sessionDataPath: string;
  logsPath: string;
  crashDumpsPath: string;
  dataRoot: string;
  tempRoot: string;
}>;

function pathInside(parent: string, child: string) {
  const traversal = relative(parent, child);
  return traversal !== "" && !isAbsolute(traversal) && traversal !== ".." && !traversal.startsWith(`..${sep}`);
}

function rejectExistingSymlinkComponents(path: string, label: string) {
  const root = parse(path).root;
  let cursor = root;
  for (const component of path.slice(root.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    const status = lstatSync(cursor);
    if (status.isSymbolicLink()) throw new Error(`${label} cannot contain symbolic-link components.`);
  }
}

function requireOwnedPrivateEntry(path: string, kind: "directory" | "file", label: string) {
  const status = lstatSync(path);
  if (status.isSymbolicLink() || (kind === "directory" ? !status.isDirectory() : !status.isFile())) {
    throw new Error(`${label} must be a real ${kind}.`);
  }
  if (realpathSync(path) !== path) throw new Error(`${label} must be canonical and unsymlinked.`);
  if (process.platform !== "win32" && (status.mode & 0o077) !== 0) {
    throw new Error(`${label} must be owner-only.`);
  }
  if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user.`);
  }
  if (kind === "file" && status.nlink !== 1) throw new Error(`${label} cannot be hard-linked.`);
  return status;
}

function sameSnapshot(left: BigIntStats, right: BigIntStats) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function readMarker(path: string, expectedSha256: string) {
  const before = lstatSync(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || before.size > BigInt(4096) || before.nlink !== BigInt(1)) {
    throw new Error("The Finder verification capsule marker is unsafe.");
  }
  const descriptor = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameSnapshot(before, opened)) {
      throw new Error("The Finder verification capsule marker changed during validation.");
    }
    const bytes = readFileSync(descriptor);
    const after = lstatSync(path, { bigint: true });
    if (!sameSnapshot(opened, after)
      || createHash("sha256").update(bytes).digest("hex") !== expectedSha256
      || bytes.toString("utf8") !== finderVerificationCapsuleMarkerBytes()) {
      throw new Error("The Finder verification capsule marker does not match the sealed profile.");
    }
  } finally {
    closeSync(descriptor);
  }
}

function validateOwnedTree(root: string) {
  let entries = 0;
  const visit = (directory: string) => {
    requireOwnedPrivateEntry(directory, "directory", "Finder verification capsule directory");
    for (const name of readdirSync(directory)) {
      entries += 1;
      if (entries > 100_000 || !name || name === "." || name === ".." || /[\\/\0\r\n]/.test(name)) {
        throw new Error("The Finder verification capsule contains unsafe or excessive content.");
      }
      const path = join(directory, name);
      const status = lstatSync(path);
      if (status.isSymbolicLink()) throw new Error("The Finder verification capsule cannot contain symbolic links.");
      if (status.isDirectory()) visit(path);
      else if (status.isFile()) requireOwnedPrivateEntry(path, "file", "Finder verification capsule file");
      else throw new Error("The Finder verification capsule contains an unsupported entry.");
    }
  };
  visit(root);
}

/**
 * Read-only validation for the one sealed Finder verification capsule. This
 * function never creates, repairs, chmods, migrates or deletes anything.
 */
export function validateFinderVerificationCapsuleReadOnly(input: {
  appDataPath: string;
  profile: DesktopFinderVerificationLaunchProfile;
}): DesktopFinderVerificationCapsule {
  const parsed = parseDesktopLaunchProfile(input.profile);
  if (!parsed || parsed.kind !== DESKTOP_FINDER_VERIFICATION_BUILD_PROFILE) {
    throw new Error("The packaged Finder verification profile is invalid.");
  }
  if (!isAbsolute(input.appDataPath) || resolve(input.appDataPath) !== input.appDataPath) {
    throw new Error("Electron appData must be an explicit normalized absolute path.");
  }
  rejectExistingSymlinkComponents(input.appDataPath, "Electron appData");
  const appData = realpathSync(input.appDataPath);
  if (appData !== input.appDataPath) throw new Error("Electron appData must be canonical.");
  requireOwnedPrivateEntry(appData, "directory", "Electron appData");
  const capsuleRoot = join(appData, ...parsed.applicationSupportRelativePath.split("/"));
  if (!pathInside(appData, capsuleRoot)) throw new Error("The Finder verification capsule escaped Application Support.");
  rejectExistingSymlinkComponents(capsuleRoot, "Finder verification capsule");
  requireOwnedPrivateEntry(capsuleRoot, "directory", "Finder verification capsule");

  const expectedTopLevel = ["capsule-profile.json", "crashDumps", "logs", "sessionData", "userData"];
  const actualTopLevel = readdirSync(capsuleRoot).sort();
  if (actualTopLevel.length !== expectedTopLevel.length
    || actualTopLevel.some((name, index) => name !== expectedTopLevel[index])) {
    throw new Error("The Finder verification capsule contains unexpected top-level content.");
  }

  const markerPath = join(capsuleRoot, "capsule-profile.json");
  requireOwnedPrivateEntry(markerPath, "file", "Finder verification capsule marker");
  readMarker(markerPath, parsed.capsuleMarkerSha256);

  const userDataPath = join(capsuleRoot, "userData");
  const sessionDataPath = join(capsuleRoot, "sessionData");
  const logsPath = join(capsuleRoot, "logs");
  const crashDumpsPath = join(capsuleRoot, "crashDumps");
  const dataRoot = join(userDataPath, "private-data");
  const tempRoot = join(dataRoot, "tmp");
  for (const path of [userDataPath, sessionDataPath, logsPath, crashDumpsPath, dataRoot, tempRoot]) {
    if (!pathInside(capsuleRoot, path)) throw new Error("The Finder verification capsule layout escaped its root.");
    requireOwnedPrivateEntry(path, "directory", "Finder verification capsule directory");
  }
  validateOwnedTree(userDataPath);
  validateOwnedTree(sessionDataPath);
  validateOwnedTree(logsPath);
  validateOwnedTree(crashDumpsPath);
  return Object.freeze({ capsuleRoot, userDataPath, sessionDataPath, logsPath, crashDumpsPath, dataRoot, tempRoot });
}
