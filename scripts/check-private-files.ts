import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
const forbidden = [
  /^\.env(?:\.|$)(?!example$)/,
  /(?:^|\/)data\/.*\.db(?:-|$)/,
  /(?:^|\/)data\/repositories\.json$/,
  /(?:^|\/)data\/knowledge\/(?:inbox|indexes|processed|backups)\//,
  /\.(?:sqlite|sqlite3)$/,
  /(?:^|\/)id_(?:rsa|ed25519)(?:\.|$)/,
];
const unsafe = tracked.filter((path) => forbidden.some((pattern) => pattern.test(path)));
if (unsafe.length) {
  console.error("Privacy check failed. These private/generated files are tracked:");
  for (const path of unsafe) console.error(`- ${path}`);
  process.exit(1);
}

const textExtensions = new Set(["", ".css", ".example", ".json", ".md", ".mjs", ".toml", ".ts", ".tsx", ".txt", ".yml", ".yaml"]);
const sensitivePatterns = [
  { name: "absolute macOS user path", pattern: /\/Users\/[A-Za-z0-9._-]+\// },
  { name: "GitHub token", pattern: /\bgh[opurs]_[A-Za-z0-9_]{20,}\b/ },
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "AWS access key", pattern: /\bAKIA[A-Z0-9]{16}\b/ },
];
const contentProblems: string[] = [];
for (const path of tracked) {
  if (!textExtensions.has(extname(path)) || statSync(path).size > 1_000_000) continue;
  const content = readFileSync(path, "utf8");
  for (const candidate of sensitivePatterns) if (candidate.pattern.test(content)) contentProblems.push(`${path}: ${candidate.name}`);
}
if (contentProblems.length) {
  console.error("Privacy check failed. Review these paths without posting their contents:");
  contentProblems.forEach((problem) => console.error(`- ${problem}`));
  process.exit(1);
}
console.log(`Privacy check passed: ${tracked.length} project files inspected.`);
