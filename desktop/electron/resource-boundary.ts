import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

const PACKAGED_RESOURCE_DIRECTORY = "rangabot-resources";
const PRIVATE_DATA_DIRECTORY = "private-data";

export type DesktopResourceBoundary = Readonly<{
  artifactRoot: string;
  resourceRoot: string;
  serverEntrypoint: string;
  desktopManifestPath: string;
}>;

export type DesktopRuntimeBoundary = Readonly<DesktopResourceBoundary & {
  dataRoot: string;
  tempRoot: string;
}>;

function assertAbsolutePath(path: string, label: string) {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error(`${label} must be an absolute normalized path.`);
  }
}

function assertInside(parent: string, child: string, label: string) {
  const traversal = relative(parent, child);
  if (!traversal || traversal === ".." || traversal.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(traversal)) {
    throw new Error(`${label} must be a distinct path inside its private root.`);
  }
}

const DARWIN_PRIVATE_ALIASES = Object.freeze(new Map([
  ["/etc", "/private/etc"],
  ["/tmp", "/private/tmp"],
  ["/var", "/private/var"],
]));

/**
 * macOS intentionally exposes /etc, /tmp and /var as root-owned aliases into
 * /private. Canonicalize only those exact operating-system aliases before
 * walking path components; all other symbolic-link components remain fatal.
 */
function normalizeOperatingSystemPrivateAlias(path: string) {
  if (process.platform !== "darwin") return path;
  for (const [alias, target] of DARWIN_PRIVATE_ALIASES) {
    if (path !== alias && !path.startsWith(`${alias}/`)) continue;
    try {
      if (realpathSync(alias) !== target) return path;
    } catch {
      return path;
    }
    return `${target}${path.slice(alias.length)}`;
  }
  return path;
}

function rejectExistingSymbolicLinkComponents(path: string, label: string) {
  const root = parse(path).root;
  let cursor = root;
  for (const component of path.slice(root.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    try {
      if (lstatSync(cursor).isSymbolicLink()) {
        throw new Error(`${label} cannot contain symbolic-link path components.`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
}

function requireUnsymlinkedDirectory(path: string, label: string) {
  rejectExistingSymbolicLinkComponents(path, label);
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`${label} must be a real directory, not a symbolic link.`);
  }
  const canonical = realpathSync(path);
  assertAbsolutePath(canonical, label);
  return canonical;
}

function requireUnsymlinkedFile(path: string, root: string, label: string) {
  assertInside(root, path, label);
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error(`${label} must be a real packaged file, not a symbolic link.`);
  }
  const canonical = realpathSync(path);
  assertInside(root, canonical, label);
  if (canonical !== path) throw new Error(`${label} cannot contain symbolic-link path components.`);
  return canonical;
}

export function resolveDesktopResourceBoundary(input: {
  resourcesPath: string;
  isPackaged: boolean;
  developmentResourceRoot?: string;
}): DesktopResourceBoundary {
  assertAbsolutePath(input.resourcesPath, "Electron resourcesPath");
  if (input.isPackaged && input.developmentResourceRoot) {
    throw new Error("A packaged desktop runtime cannot override its packaged resource root.");
  }

  const resourcesPath = normalizeOperatingSystemPrivateAlias(input.resourcesPath);
  const artifactRoot = requireUnsymlinkedDirectory(resourcesPath, "Electron resourcesPath");
  const selectedRoot = input.developmentResourceRoot
    ? normalizeOperatingSystemPrivateAlias(input.developmentResourceRoot)
    : join(resourcesPath, PACKAGED_RESOURCE_DIRECTORY);
  assertAbsolutePath(selectedRoot, "Rangabot desktop resource root");
  const resourceRoot = requireUnsymlinkedDirectory(selectedRoot, "Rangabot desktop resource root");
  assertInside(artifactRoot, resourceRoot, "Rangabot desktop resource root");
  const serverEntrypoint = requireUnsymlinkedFile(
    join(resourceRoot, "server.js"),
    resourceRoot,
    "Rangabot packaged server entrypoint",
  );
  const desktopManifestPath = requireUnsymlinkedFile(
    join(resourceRoot, "desktop", "manifest.json"),
    resourceRoot,
    "Rangabot desktop artifact manifest",
  );
  assertInside(artifactRoot, desktopManifestPath, "Rangabot desktop artifact manifest");

  return Object.freeze({ artifactRoot, resourceRoot, serverEntrypoint, desktopManifestPath });
}

export function ensurePrivateDesktopDataRoot(userDataPath: string) {
  assertAbsolutePath(userDataPath, "Electron userData path");
  userDataPath = normalizeOperatingSystemPrivateAlias(userDataPath);
  rejectExistingSymbolicLinkComponents(userDataPath, "Electron userData path");
  try {
    mkdirSync(userDataPath, { mode: 0o700, recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  rejectExistingSymbolicLinkComponents(userDataPath, "Electron userData path");
  const userDataRoot = requireUnsymlinkedDirectory(userDataPath, "Electron userData path");
  const requestedDataRoot = join(userDataRoot, PRIVATE_DATA_DIRECTORY);
  assertInside(userDataRoot, requestedDataRoot, "Rangabot private data root");

  try {
    mkdirSync(requestedDataRoot, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const dataRoot = requireUnsymlinkedDirectory(requestedDataRoot, "Rangabot private data root");
  assertInside(userDataRoot, dataRoot, "Rangabot private data root");
  chmodSync(dataRoot, 0o700);
  const privateStat = statSync(dataRoot);
  if (process.platform !== "win32" && (privateStat.mode & 0o077) !== 0) {
    throw new Error("Rangabot's desktop data root is not owner-only.");
  }
  if (typeof process.getuid === "function" && privateStat.uid !== process.getuid()) {
    throw new Error("Rangabot's desktop data root is not owned by the current user.");
  }
  return dataRoot;
}

export function createDesktopRuntimeBoundaryFromVerifiedResources(input: {
  resources: DesktopResourceBoundary;
  userDataPath: string;
}): DesktopRuntimeBoundary {
  const dataRoot = ensurePrivateDesktopDataRoot(input.userDataPath);
  const requestedTempRoot = join(dataRoot, "tmp");
  try {
    mkdirSync(requestedTempRoot, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const tempRoot = requireUnsymlinkedDirectory(requestedTempRoot, "Rangabot private temporary root");
  assertInside(dataRoot, tempRoot, "Rangabot private temporary root");
  chmodSync(tempRoot, 0o700);
  return Object.freeze({ ...input.resources, dataRoot, tempRoot });
}

export function createDesktopRuntimeBoundary(input: {
  resourcesPath: string;
  userDataPath: string;
  isPackaged: boolean;
  developmentResourceRoot?: string;
}): DesktopRuntimeBoundary {
  return createDesktopRuntimeBoundaryFromVerifiedResources({
    resources: resolveDesktopResourceBoundary(input),
    userDataPath: input.userDataPath,
  });
}
