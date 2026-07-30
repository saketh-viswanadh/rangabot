import { readFileSync } from "node:fs";
import { hasMasteryApproval, requiresMasteryApproval } from "../lib/mastery-governance.ts";

if (process.env.GITHUB_EVENT_NAME !== "pull_request") {
  console.log("Mastery governance: no pull request approval required for this event.");
  process.exit(0);
}

const eventPath = process.env.GITHUB_EVENT_PATH;
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
if (!eventPath || !repository || !token) throw new Error("Mastery governance requires the GitHub pull-request environment.");

const event = JSON.parse(readFileSync(eventPath, "utf8")) as { pull_request?: { number?: number; labels?: Array<{ name?: string }> } };
const number = event.pull_request?.number;
if (!number) throw new Error("Mastery governance could not identify the pull request.");

const files: string[] = [];
for (let page = 1; page <= 10; page += 1) {
  const response = await fetch(`https://api.github.com/repos/${repository}/pulls/${number}/files?per_page=100&page=${page}`, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!response.ok) throw new Error(`Mastery governance could not inspect pull-request files (${response.status}).`);
  const entries = await response.json() as Array<{ filename: string }>;
  files.push(...entries.map((entry) => entry.filename));
  if (entries.length < 100) break;
}

if (!requiresMasteryApproval(files)) {
  console.log("Mastery governance: no protected mastery files changed.");
  process.exit(0);
}

const pullRequestResponse = await fetch(`https://api.github.com/repos/${repository}/pulls/${number}`, {
  headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
});
if (!pullRequestResponse.ok) throw new Error(`Mastery governance could not inspect current approval labels (${pullRequestResponse.status}).`);
const pullRequest = await pullRequestResponse.json() as { labels?: Array<{ name?: string }> };
const labels = pullRequest.labels?.flatMap((label) => label.name ? [label.name] : []) ?? [];
if (!hasMasteryApproval(labels)) {
  throw new Error("Protected mastery data changed without the owner-controlled 'mastery-approved' label. Open a claim issue and request official approval.");
}
console.log("Mastery governance: protected changes carry official owner approval.");
