export const MASTERY_GOVERNANCE_PROTECTED_FILES = [
  ".github/CODEOWNERS",
  ".github/ISSUE_TEMPLATE/mastery-claim.yml",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "content/rangabot-charter.json",
  "docs/RANGABOT_CHARTER.md",
  "content/path-to-mastery.json",
  "content/mastery-contributors.json",
  "content/mastery-evidence.json",
  "docs/PATH_TO_MASTERY.md",
  "docs/mastery-claims.md",
  "lib/mastery-tree.ts",
  "lib/mastery-contributors.ts",
  "lib/mastery-governance.ts",
  "scripts/check-mastery-evidence.ts",
  "scripts/check-mastery-governance.ts",
  "scripts/generate-charter.ts",
  "scripts/generate-mastery-tree.ts",
  "tests/mastery-governance-workflow.test.ts",
] as const;

export const MASTERY_GOVERNANCE_PROTECTED_PREFIXES = [".github/workflows/"] as const;

const protectedMasteryFiles = new Set<string>(MASTERY_GOVERNANCE_PROTECTED_FILES);

export function requiresMasteryApproval(files: string[]): boolean {
  return files.some((file) => {
    const normalized = file.replaceAll("\\", "/");
    return protectedMasteryFiles.has(normalized) || MASTERY_GOVERNANCE_PROTECTED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
  });
}

export function hasMasteryApproval(labels: string[]): boolean {
  return labels.some((label) => label.toLowerCase() === "mastery-approved");
}
