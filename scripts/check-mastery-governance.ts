import { readFileSync } from "node:fs";
import { hasMasteryApproval, requiresMasteryApproval } from "../lib/mastery-governance.ts";

async function main() {
  if (!new Set(["pull_request", "pull_request_target"]).has(process.env.GITHUB_EVENT_NAME ?? "")) {
    console.log("Mastery governance: no pull request approval required for this event.");
    return;
  }

  const eventPath = process.env.GITHUB_EVENT_PATH;
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!eventPath || !repository || !token) throw new Error("Mastery governance requires the GitHub pull-request environment.");

  const event = JSON.parse(readFileSync(eventPath, "utf8")) as { pull_request?: { number?: number } };
  const number = event.pull_request?.number;
  if (!number) throw new Error("Mastery governance could not identify the pull request.");

  const pullRequestResponse = await fetch(`https://api.github.com/repos/${repository}/pulls/${number}`, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!pullRequestResponse.ok) throw new Error(`Mastery governance could not inspect current pull-request metadata (${pullRequestResponse.status}).`);
  const pullRequest = await pullRequestResponse.json() as { changed_files?: number; labels?: Array<{ name?: string }> };
  const expectedFileCount = pullRequest.changed_files;
  if (!Number.isSafeInteger(expectedFileCount) || expectedFileCount === undefined || expectedFileCount < 0) {
    throw new Error("Mastery governance received an invalid changed-file count.");
  }
  if (expectedFileCount > 3000) {
    throw new Error(`Mastery governance cannot prove completeness for ${expectedFileCount} changed files; split the pull request.`);
  }

  const files: string[] = [];
  const pageCount = Math.ceil(expectedFileCount / 100);
  for (let page = 1; page <= pageCount; page += 1) {
    const response = await fetch(`https://api.github.com/repos/${repository}/pulls/${number}/files?per_page=100&page=${page}`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!response.ok) throw new Error(`Mastery governance could not inspect pull-request files (${response.status}).`);
    const entries = await response.json() as Array<{ filename?: string; previous_filename?: string }>;
    const expectedPageSize = Math.min(100, expectedFileCount - (page - 1) * 100);
    if (!Array.isArray(entries) || entries.length !== expectedPageSize) {
      throw new Error(`Mastery governance file pagination was incomplete on page ${page}.`);
    }
    for (const entry of entries) {
      if (typeof entry.filename !== "string") throw new Error("Mastery governance received an invalid changed-file record.");
      files.push(entry.filename);
      if (entry.previous_filename !== undefined) files.push(entry.previous_filename);
    }
  }

  if (!requiresMasteryApproval(files)) {
    console.log("Mastery governance: no protected mastery files changed.");
    return;
  }

  const labels = pullRequest.labels?.flatMap((label) => label.name ? [label.name] : []) ?? [];
  if (!hasMasteryApproval(labels)) {
    throw new Error("Protected mastery data changed without the owner-controlled 'mastery-approved' label. Open a claim issue and request official approval.");
  }
  console.log("Mastery governance: protected changes carry official owner approval.");
}

await main();
