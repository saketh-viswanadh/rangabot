import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, parse, resolve } from "node:path";
import { ensurePrivateFile, writePrivateJsonFileAtomic } from "./private-storage.ts";

export interface AllowedRepository {
  id: string;
  name: string;
  path: string;
  addedAt: string;
  /**
   * Binds an approval to the directory that existed when the user approved it.
   * Older registry entries omit this and must be explicitly approved again.
   */
  rootIdentity?: RepositoryRootIdentity;
}

export interface RepositoryRootIdentity {
  device: string;
  inode: string;
}

const defaultRegistryPath = resolve(process.cwd(), "data", "repositories.json");
let registryPath = defaultRegistryPath;

function readRegistry(): AllowedRepository[] {
  if (!existsSync(/* turbopackIgnore: true */ registryPath)) return [];
  ensurePrivateFile(registryPath);
  const value: unknown = JSON.parse(readFileSync(/* turbopackIgnore: true */ registryPath, "utf8"));
  if (!Array.isArray(value) || !value.every((item) => (
    item && typeof item === "object"
    && typeof (item as AllowedRepository).id === "string"
    && typeof (item as AllowedRepository).name === "string"
    && typeof (item as AllowedRepository).path === "string"
    && typeof (item as AllowedRepository).addedAt === "string"
    && ((item as AllowedRepository).rootIdentity === undefined || (
      typeof (item as AllowedRepository).rootIdentity === "object"
      && (item as AllowedRepository).rootIdentity !== null
      && /^\d+$/.test((item as AllowedRepository).rootIdentity?.device ?? "")
      && /^\d+$/.test((item as AllowedRepository).rootIdentity?.inode ?? "")
    ))
  ))) throw new Error("The local repository allowlist is damaged.");
  return value as AllowedRepository[];
}

function inspectCanonicalDirectory(path: string) {
  const metadata = lstatSync(/* turbopackIgnore: true */ path, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("The selected path is not a folder.");
  return {
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
  } satisfies RepositoryRootIdentity;
}

function sameRootIdentity(left: RepositoryRootIdentity, right: RepositoryRootIdentity) {
  return left.device === right.device && left.inode === right.inode;
}

function writeRegistry(repositories: AllowedRepository[]) {
  writePrivateJsonFileAtomic(registryPath, repositories);
}

export function listAllowedRepositories() {
  return readRegistry();
}

export function getAllowedRepository(id: string) {
  return readRegistry().find((repository) => repository.id === id) ?? null;
}

/**
 * Resolves and verifies the approved root immediately before repository access.
 * This rejects legacy approvals and directories that were removed, replaced, or
 * retargeted through a symbolic link after approval.
 */
export function validateAllowedRepositoryRoot(repository: AllowedRepository) {
  if (!repository.rootIdentity) {
    throw new Error("This repository approval predates identity checks. Approve the folder again before reading it.");
  }
  if (!isAbsolute(repository.path)) {
    throw new Error("The approved repository path is invalid. Approve the folder again.");
  }

  let canonicalPath: string;
  let currentIdentity: RepositoryRootIdentity;
  try {
    const metadata = lstatSync(/* turbopackIgnore: true */ repository.path, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("changed");
    }
    canonicalPath = realpathSync(/* turbopackIgnore: true */ repository.path);
    currentIdentity = {
      device: metadata.dev.toString(),
      inode: metadata.ino.toString(),
    };
  } catch {
    throw new Error("The approved repository changed or is unavailable. Approve the folder again before reading it.");
  }

  if (canonicalPath !== repository.path || !sameRootIdentity(repository.rootIdentity, currentIdentity)) {
    throw new Error("The approved repository changed or was replaced. Approve the folder again before reading it.");
  }
  return canonicalPath;
}

export function allowRepository(inputPath: string): AllowedRepository {
  const candidate = inputPath.trim();
  if (!candidate || candidate.length > 1024 || !isAbsolute(candidate)) {
    throw new Error("Enter an absolute folder path.");
  }
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(/* turbopackIgnore: true */ candidate);
  } catch {
    throw new Error("That folder does not exist or cannot be accessed.");
  }
  const rootIdentity = inspectCanonicalDirectory(canonicalPath);
  if (canonicalPath === parse(canonicalPath).root || canonicalPath === realpathSync(/* turbopackIgnore: true */ homedir())) {
    throw new Error("Choose a specific project folder, not the filesystem root or your entire home folder.");
  }
  const repositories = readRegistry();
  const existing = repositories.find((repository) => repository.path === canonicalPath);
  if (existing?.rootIdentity && sameRootIdentity(existing.rootIdentity, rootIdentity)) return existing;

  const repository = {
    id: existing?.id ?? randomUUID(),
    name: basename(canonicalPath),
    path: canonicalPath,
    addedAt: new Date().toISOString(),
    rootIdentity,
  } satisfies AllowedRepository;
  writeRegistry(existing
    ? repositories.map((item) => item.id === existing.id ? repository : item)
    : [...repositories, repository]);
  return repository;
}

export function revokeRepository(id: string) {
  const repositories = readRegistry();
  const next = repositories.filter((repository) => repository.id !== id);
  if (next.length === repositories.length) return false;
  writeRegistry(next);
  return true;
}

export function setRepositoryRegistryPathForTests(path: string) {
  registryPath = path;
}

export function resetRepositoryRegistryPathForTests() {
  registryPath = defaultRegistryPath;
}
