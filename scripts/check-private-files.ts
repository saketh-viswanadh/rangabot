import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
const forbidden = [
  /(?:^|\/)\.env(?:\.|$)(?!example$)/,
  /(?:^|\/)\.(?:npmrc|netrc)$/,
  /\.(?:pem|key|p12|pfx)$/i,
  /(?:^|\/)[^/]*(?:credentials|service-account)[^/]*\.json$/i,
  /(?:^|\/)data\/.*\.db(?:-|$)/,
  /(?:^|\/)data\/(?:repositories|datasets|sql-confirmations)\.json(?:\..*\.tmp)?$/,
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

const textExtensions = new Set([
  "", ".cjs", ".conf", ".css", ".csv", ".example", ".html", ".ini", ".js",
  ".json", ".jsx", ".md", ".mjs", ".sh", ".sql", ".svg", ".toml", ".ts",
  ".tsx", ".txt", ".xml", ".yml", ".yaml",
]);
const maxTextScanBytes = 10_000_000;
type SensitivePattern = { name: string; pattern: RegExp; allowedFixturePaths?: Set<string> };
const sensitivePatterns: SensitivePattern[] = [
  { name: "absolute macOS user path", pattern: /\/Users\/[A-Za-z0-9._-]+\// },
  { name: "GitHub token", pattern: /\bgh[opurs]_[A-Za-z0-9_]{20,}\b/ },
  { name: "GitHub fine-grained token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: "OpenAI-compatible secret", pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "Anthropic secret", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "Slack token", pattern: /\bxox(?:b|p|a|r|s)-[A-Za-z0-9-]{20,}\b/ },
  { name: "Stripe live secret", pattern: /\bsk_live_[A-Za-z0-9]{16,}\b/ },
  { name: "Google API key", pattern: /\bAIza[A-Za-z0-9_-]{30,}\b/ },
  { name: "npm authentication token", pattern: /(?:^|\n)\s*(?:\/\/[^\n]+:)?_authToken\s*=\s*[^\s$][^\n]*/i },
  { name: "authenticated URL", pattern: /\bhttps?:\/\/[^\s/:@]+:[^\s/@]+@[^\s]+/i, allowedFixturePaths: new Set(["tests/local-runtime-config.test.ts"]) },
  { name: "JWT-like bearer token", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "AWS access key", pattern: /\bAKIA[A-Z0-9]{16}\b/ },
];
const contentProblems: string[] = [];
for (const path of tracked) {
  if (!existsSync(path)) continue;
  if (!textExtensions.has(extname(path))) continue;
  if (statSync(path).size > maxTextScanBytes) {
    contentProblems.push(`${path}: text file exceeds the bounded privacy scanner`);
    continue;
  }
  const content = readFileSync(path, "utf8");
  for (const candidate of sensitivePatterns) {
    if (candidate.pattern.test(content) && !candidate.allowedFixturePaths?.has(path)) {
      contentProblems.push(`${path}: ${candidate.name}`);
    }
  }
}
if (contentProblems.length) {
  console.error("Privacy check failed. Review these paths without posting their contents:");
  contentProblems.forEach((problem) => console.error(`- ${problem}`));
  process.exit(1);
}

const historyPatch = execFileSync("git", ["log", "--all", "--format=", "--no-ext-diff", "-p", "--", "."], {
  encoding: "utf8",
  maxBuffer: 128 * 1024 * 1024,
}).replaceAll(["http://user", "pass@127.0.0.1:11434"].join(":"), "synthetic-authenticated-url-fixture");
const historyProblems = sensitivePatterns.filter((candidate) => candidate.pattern.test(historyPatch)).map((candidate) => candidate.name);
if (historyProblems.length) {
  console.error("Privacy check failed. Git history contains possible secret material:");
  historyProblems.forEach((name) => console.error(`- ${name}`));
  console.error("Rotate any real credential before attempting a coordinated history rewrite.");
  process.exit(1);
}

const historyEmails = new Set(execFileSync("git", ["log", "--all", "--format=%ae%n%ce"], { encoding: "utf8" })
  .split(/\r?\n/)
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean));
const publicPersonalEmails = [...historyEmails].filter((email) =>
  !email.endsWith("@users.noreply.github.com")
  && email !== "noreply@github.com"
  && !email.endsWith("@example.com"));
if (publicPersonalEmails.length) {
  console.warn(`Privacy warning: Git history contains ${publicPersonalEmails.length} non-noreply author or committer email address${publicPersonalEmails.length === 1 ? "" : "es"}. Values are intentionally redacted; removing old metadata requires a coordinated history rewrite.`);
}
console.log(`Privacy check passed: ${tracked.length} project files inspected.`);
