import type { AllowedRepository } from "./repositories";
import type { CodePreview } from "./repository-search";

export type CodeContextRequest = { repositoryId: string; path: string; line: number; previewSha256?: string };

export function isCodeContextRequest(value: unknown): value is CodeContextRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Object.keys(value).every((key) => ["repositoryId", "path", "line", "previewSha256"].includes(key))) return false;
  const candidate = value as Partial<CodeContextRequest>;
  return typeof candidate.repositoryId === "string" && candidate.repositoryId.length <= 100
    && typeof candidate.path === "string" && candidate.path.length > 0 && candidate.path.length <= 1024
    && typeof candidate.line === "number" && Number.isInteger(candidate.line) && candidate.line > 0
    && (candidate.previewSha256 === undefined || /^[a-f0-9]{64}$/.test(candidate.previewSha256));
}

export function formatCodeContext(repository: AllowedRepository, preview: CodePreview) {
  const endLine = preview.startLine + preview.lines.length - 1;
  const numberedLines = preview.lines.map((line, index) => `${preview.startLine + index}: ${line}`).join("\n");
  return `APPROVED LOCAL CODE CONTEXT\nRepository: ${repository.name}\nFile: ${preview.path}\nLines: ${preview.startLine}-${endLine}\n\n${numberedLines}`;
}
