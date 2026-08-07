const protectedMasteryFiles = new Set([
  "content/rangabot-charter.json",
  "docs/RANGABOT_CHARTER.md",
  "content/path-to-mastery.json",
  "content/mastery-contributors.json",
  "content/mastery-evidence.json",
  "docs/PATH_TO_MASTERY.md",
  "lib/mastery-tree.ts",
  "lib/mastery-contributors.ts",
  "scripts/check-mastery-evidence.ts",
  "scripts/generate-charter.ts",
  "scripts/generate-mastery-tree.ts",
]);

export function requiresMasteryApproval(files: string[]): boolean {
  return files.some((file) => protectedMasteryFiles.has(file.replaceAll("\\", "/")));
}

export function hasMasteryApproval(labels: string[]): boolean {
  return labels.some((label) => label.toLowerCase() === "mastery-approved");
}
