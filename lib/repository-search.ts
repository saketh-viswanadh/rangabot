import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import type { AllowedRepository } from "./repositories";

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

function readSafeText(path: string) {
  if (!isSearchablePath(path) || statSync(path).size > maxFileBytes) return null;
  const buffer = readFileSync(path);
  if (buffer.includes(0)) return null;
  const content = buffer.toString("utf8");
  return containsLikelySecret(content) ? null : content;
}

export function searchRepository(repository: AllowedRepository, rawQuery: string): CodeSearchResult[] {
  const query = rawQuery.trim();
  if (query.length < 2 || query.length > 120) throw new Error("Search queries must contain between 2 and 120 characters.");
  const root = realpathSync(repository.path);
  const pending = [root];
  const results: CodeSearchResult[] = [];
  let visited = 0;
  while (pending.length && results.length < maxResults && visited < maxVisitedEntries) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      visited += 1;
      if (visited >= maxVisitedEntries || results.length >= maxResults) break;
      if (entry.isSymbolicLink()) continue;
      const path = resolve(/* turbopackIgnore: true */ directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name) && !entry.name.startsWith(".")) pending.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const content = readSafeText(path);
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
  const root = realpathSync(repository.path);
  const candidate = resolve(/* turbopackIgnore: true */ root, relativePath);
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(candidate);
  } catch {
    throw new Error("The requested file does not exist.");
  }
  if (!withinRoot(root, canonicalPath)) throw new Error("The requested file is outside the approved repository.");
  if (!lstatSync(canonicalPath).isFile()) throw new Error("The requested path is not a file.");
  const content = readSafeText(canonicalPath);
  if (content === null) throw new Error("This file type cannot be previewed safely.");
  const allLines = content.split(/\r?\n/);
  const focusLine = Math.max(1, Math.min(Math.floor(requestedLine) || 1, allLines.length));
  const startLine = Math.max(1, focusLine - 24);
  const endLine = Math.min(allLines.length, focusLine + 35);
  return { path: relative(root, canonicalPath), startLine, focusLine, lines: allLines.slice(startLine - 1, endLine).map((line) => line.slice(0, 500)) };
}
