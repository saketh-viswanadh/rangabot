import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import { validateAllowedRepositoryRoot, type AllowedRepository } from "./repositories.ts";

export type CodeSearchResult = { path: string; line: number; excerpt: string };
export type CodePreview = { path: string; startLine: number; focusLine: number; lines: string[] };

const ignoredDirectories = new Set([".git", ".next", ".turbo", ".venv", "__pycache__", "build", "coverage", "dist", "node_modules", "target", "vendor"]);
const searchableExtensions = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".csv", ".go", ".graphql", ".h", ".hpp", ".html", ".java", ".js", ".json", ".jsx", ".kt", ".md", ".mjs", ".php", ".proto", ".py", ".r", ".rb", ".rs", ".scala", ".scss", ".sh", ".sql", ".svelte", ".swift", ".toml", ".ts", ".tsx", ".txt", ".vue", ".xml", ".yaml", ".yml",
]);
const searchableNames = new Set(["dockerfile", "makefile", "readme", "license"]);
const maxFileBytes = 1024 * 1024;
const maxVisitedEntries = 12_000;
const maxResults = 50;

function isPrivateName(name: string) {
  const lower = name.toLowerCase();
  return lower === ".env" || lower.startsWith(".env.") || lower.includes("credential") || lower.includes("secret") || /^id_(rsa|ed25519)/.test(lower) || lower.endsWith(".pem") || lower.endsWith(".key");
}

function isSearchablePath(path: string) {
  const name = path.split(/[\\/]/).at(-1) ?? "";
  if (isPrivateName(name)) return false;
  const lowerName = name.toLowerCase();
  return searchableExtensions.has(extname(lowerName)) || searchableNames.has(lowerName);
}

function containsLikelySecret(content: string) {
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)
    || /\bgh[opurs]_[A-Za-z0-9_]{20,}\b/.test(content)
    || /\bAKIA[A-Z0-9]{16}\b/.test(content)
    || /\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*["'][^"'\r\n]{12,}["']/i.test(content);
}

function withinRoot(root: string, path: string) {
  return path === root || path.startsWith(`${root}${sep}`);
}

function resolveSafeFile(root: string, path: string) {
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(/* turbopackIgnore: true */ path);
  } catch {
    throw new Error("The requested file does not exist.");
  }
  if (!withinRoot(root, canonicalPath)) throw new Error("The requested file is outside the approved repository.");
  // Search and preview deliberately refuse symlink traversal, including links
  // that currently resolve inside the root. This keeps access stable if links
  // are later retargeted and makes the approved tree the only readable tree.
  if (canonicalPath !== path) throw new Error("Symbolic links cannot be read through repository access.");
  const metadata = lstatSync(/* turbopackIgnore: true */ canonicalPath, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("The requested path is not a file.");
  return { canonicalPath, metadata };
}

function readSafeText(repository: AllowedRepository, root: string, path: string) {
  if (!isSearchablePath(path)) return null;
  // Revalidate the approval immediately before opening each candidate. This
  // prevents a renamed or symlink-replaced root from inheriting old access.
  if (validateAllowedRepositoryRoot(repository) !== root) {
    throw new Error("The approved repository changed. Approve the folder again before reading it.");
  }

  let resolved: ReturnType<typeof resolveSafeFile>;
  try {
    resolved = resolveSafeFile(root, path);
  } catch {
    return null;
  }
  if (resolved.metadata.size > BigInt(maxFileBytes)) return null;

  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  let descriptor: number;
  try {
    descriptor = openSync(resolved.canonicalPath, constants.O_RDONLY | noFollow);
  } catch {
    return null;
  }
  try {
    let openedMetadata: ReturnType<typeof fstatSync>;
    try {
      openedMetadata = fstatSync(descriptor, { bigint: true });
    } catch {
      return null;
    }
    if (!openedMetadata.isFile()
      || openedMetadata.dev !== resolved.metadata.dev
      || openedMetadata.ino !== resolved.metadata.ino
      || openedMetadata.size > BigInt(maxFileBytes)) return null;
    if (validateAllowedRepositoryRoot(repository) !== root) {
      throw new Error("The approved repository changed. Approve the folder again before reading it.");
    }
    const buffer = Buffer.alloc(Math.min(Number(openedMetadata.size) + 1, maxFileBytes + 1));
    let bytesRead: number;
    try {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    } catch {
      return null;
    }
    if (bytesRead === buffer.length) return null;
    if (validateAllowedRepositoryRoot(repository) !== root) {
      throw new Error("The approved repository changed. Approve the folder again before reading it.");
    }
    const contentBuffer = buffer.subarray(0, bytesRead);
    if (contentBuffer.includes(0)) return null;
    const content = contentBuffer.toString("utf8");
    return containsLikelySecret(content) ? null : content;
  } finally {
    closeSync(descriptor);
  }
}

function isSafeDirectory(repository: AllowedRepository, root: string, path: string) {
  if (validateAllowedRepositoryRoot(repository) !== root || !withinRoot(root, path)) return false;
  try {
    const canonicalPath = realpathSync(/* turbopackIgnore: true */ path);
    const metadata = lstatSync(/* turbopackIgnore: true */ path);
    return canonicalPath === path && withinRoot(root, canonicalPath) && metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

export function searchRepository(repository: AllowedRepository, rawQuery: string): CodeSearchResult[] {
  const query = rawQuery.trim();
  if (query.length < 2 || query.length > 120) throw new Error("Search queries must contain between 2 and 120 characters.");
  const root = validateAllowedRepositoryRoot(repository);
  const pending = [root];
  const results: CodeSearchResult[] = [];
  let visited = 0;
  while (pending.length && results.length < maxResults && visited < maxVisitedEntries) {
    const directory = pending.pop()!;
    if (!isSafeDirectory(repository, root, directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      visited += 1;
      if (visited >= maxVisitedEntries || results.length >= maxResults) break;
      if (entry.isSymbolicLink()) continue;
      const path = resolve(/* turbopackIgnore: true */ directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name) && !entry.name.startsWith(".") && isSafeDirectory(repository, root, path)) pending.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const content = readSafeText(repository, root, path);
      if (content === null) continue;
      const needle = query.toLowerCase();
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length && results.length < maxResults; index += 1) {
        if (!lines[index].toLowerCase().includes(needle)) continue;
        results.push({ path: relative(root, path), line: index + 1, excerpt: lines[index].trim().slice(0, 240) });
      }
    }
  }
  return results;
}

export function previewRepositoryFile(repository: AllowedRepository, relativePath: string, requestedLine = 1): CodePreview {
  if (!relativePath || relativePath.length > 1024) throw new Error("A valid relative file path is required.");
  const root = validateAllowedRepositoryRoot(repository);
  const candidate = resolve(/* turbopackIgnore: true */ root, relativePath);
  const { canonicalPath } = resolveSafeFile(root, candidate);
  const content = readSafeText(repository, root, canonicalPath);
  if (content === null) throw new Error("This file type cannot be previewed safely.");
  const allLines = content.split(/\r?\n/);
  const focusLine = Math.max(1, Math.min(Math.floor(requestedLine) || 1, allLines.length));
  const startLine = Math.max(1, focusLine - 24);
  const endLine = Math.min(allLines.length, focusLine + 35);
  return { path: relative(root, canonicalPath), startLine, focusLine, lines: allLines.slice(startLine - 1, endLine).map((line) => line.slice(0, 500)) };
}
