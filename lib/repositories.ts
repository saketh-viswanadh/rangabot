import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, parse, resolve } from "node:path";

export interface AllowedRepository {
  id: string;
  name: string;
  path: string;
  addedAt: string;
}

const defaultRegistryPath = resolve(process.cwd(), "data", "repositories.json");
let registryPath = defaultRegistryPath;

function readRegistry(): AllowedRepository[] {
  if (!existsSync(registryPath)) return [];
  const value: unknown = JSON.parse(readFileSync(registryPath, "utf8"));
  if (!Array.isArray(value) || !value.every((item) => (
    item && typeof item === "object"
    && typeof (item as AllowedRepository).id === "string"
    && typeof (item as AllowedRepository).name === "string"
    && typeof (item as AllowedRepository).path === "string"
    && typeof (item as AllowedRepository).addedAt === "string"
  ))) throw new Error("The local repository allowlist is damaged.");
  return value as AllowedRepository[];
}

function writeRegistry(repositories: AllowedRepository[]) {
  mkdirSync(dirname(registryPath), { recursive: true });
  const temporaryPath = `${registryPath}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(repositories, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, registryPath);
}

export function listAllowedRepositories() {
  return readRegistry();
}

export function allowRepository(inputPath: string): AllowedRepository {
  const candidate = inputPath.trim();
  if (!candidate || candidate.length > 1024 || !isAbsolute(candidate)) {
    throw new Error("Enter an absolute folder path.");
  }
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(candidate);
  } catch {
    throw new Error("That folder does not exist or cannot be accessed.");
  }
  if (!statSync(canonicalPath).isDirectory()) throw new Error("The selected path is not a folder.");
  if (canonicalPath === parse(canonicalPath).root || canonicalPath === realpathSync(homedir())) {
    throw new Error("Choose a specific project folder, not the filesystem root or your entire home folder.");
  }
  const repositories = readRegistry();
  const existing = repositories.find((repository) => repository.path === canonicalPath);
  if (existing) return existing;
  const repository = { id: randomUUID(), name: basename(canonicalPath), path: canonicalPath, addedAt: new Date().toISOString() };
  writeRegistry([...repositories, repository]);
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
