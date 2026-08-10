import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MASTERY_GOVERNANCE_PROTECTED_FILES, MASTERY_GOVERNANCE_PROTECTED_PREFIXES } from "../lib/mastery-governance.ts";

const workflowPath = ".github/workflows/mastery-governance.yml";
const workflow = readFileSync(workflowPath, "utf8");

function extractWorkflowScript(source: string): string {
  const lines = source.split("\n");
  const markerIndex = lines.findIndex((line) => /^\s+script: \|\s*$/.test(line));
  assert.notEqual(markerIndex, -1, "workflow must contain an inline metadata checker");
  const markerIndent = lines[markerIndex].match(/^\s*/)?.[0].length ?? 0;
  const bodyIndent = " ".repeat(markerIndent + 2);
  const body: string[] = [];
  for (const line of lines.slice(markerIndex + 1)) {
    if (line.length === 0) {
      body.push("");
      continue;
    }
    if (!line.startsWith(bodyIndent)) break;
    body.push(line.slice(bodyIndent.length));
  }
  assert.ok(body.length > 0, "workflow metadata checker must not be empty");
  return body.join("\n");
}

type PullFile = { filename: string; previous_filename?: string };
type IssueEvent = {
  id: number;
  event: "labeled" | "unlabeled" | "commented";
  created_at: string;
  label?: { name: string };
  actor?: { login: string };
};
type CommitStatus = { id: number; context: string; state: string };
type CommitStatusRequest = Omit<CommitStatus, "id"> & { sha: string; description: string };

const currentHeadSha = "a".repeat(40);
const staleHeadSha = "b".repeat(40);

async function executeWorkflowScript(options: {
  files: PullFile[];
  labels?: string[];
  changedFileCount?: number;
  pageOverride?: (page: number, entries: PullFile[]) => PullFile[];
  action?: string;
  headSha?: string;
  eventHeadSha?: string;
  eventActor?: string;
  issueEvents?: IssueEvent[];
  actorPermission?: string;
  statuses?: CommitStatus[];
}) {
  const requestedPages: number[] = [];
  const requestedIssueEventPages: number[] = [];
  const requestedStatusPages: number[] = [];
  const createdStatuses: CommitStatus[] = [];
  const createdStatusRequests: CommitStatusRequest[] = [];
  const headSha = options.headSha ?? currentHeadSha;
  const issueEvents = options.issueEvents ?? [{
    id: 1,
    event: "labeled",
    created_at: "2026-08-10T00:00:00.000Z",
    label: { name: "mastery-approved" },
    actor: { login: options.eventActor ?? "maintainer" },
  }];
  const statuses = options.statuses ?? [{ id: 1, context: "rangabot/mastery-approval", state: "success" }];
  const github = {
    rest: {
      pulls: {
        get: async () => ({
          data: {
            changed_files: options.changedFileCount ?? options.files.length,
            labels: (options.labels ?? []).map((name) => ({ name })),
            head: { sha: headSha },
          },
        }),
        listFiles: async ({ page, per_page }: { page: number; per_page: number }) => {
          requestedPages.push(page);
          const entries = options.files.slice((page - 1) * per_page, page * per_page);
          return { data: options.pageOverride?.(page, entries) ?? entries };
        },
      },
      issues: {
        listEvents: async ({ page, per_page }: { page: number; per_page: number }) => {
          requestedIssueEventPages.push(page);
          return { data: issueEvents.slice((page - 1) * per_page, page * per_page) };
        },
      },
      repos: {
        getCollaboratorPermissionLevel: async () => ({ data: { permission: options.actorPermission ?? "admin" } }),
        listCommitStatusesForRef: async ({ page, per_page }: { page: number; per_page: number }) => {
          requestedStatusPages.push(page);
          return { data: statuses.slice((page - 1) * per_page, page * per_page) };
        },
        createCommitStatus: async (status: CommitStatusRequest) => {
          createdStatusRequests.push(status);
          const created = { id: 1000 + createdStatuses.length, context: status.context, state: status.state };
          createdStatuses.push(created);
          return { data: created };
        },
      },
    },
  };
  const context = {
    repo: { owner: "example", repo: "rangabot" },
    payload: {
      action: options.action ?? "synchronize",
      label: options.action === "labeled" ? { name: "mastery-approved" } : undefined,
      pull_request: { number: 42, head: { sha: options.eventHeadSha ?? headSha } },
      sender: { login: options.eventActor ?? "maintainer" },
    },
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<void>;
  const run = new AsyncFunction("github", "context", "core", extractWorkflowScript(workflow));
  await run(github, context, {});
  return { requestedPages, requestedIssueEventPages, requestedStatusPages, createdStatuses, createdStatusRequests };
}

test("mastery governance runs trusted metadata only with one receipt-scoped write permission", () => {
  assert.match(workflow, /^\s*pull_request_target:\s*$/m);
  assert.doesNotMatch(workflow, /^\s*pull_request:\s*$/m);
  assert.doesNotMatch(workflow, /actions\/checkout/i);
  assert.doesNotMatch(workflow, /^\s*-?\s*run:/m);
  const writePermissions = [...workflow.matchAll(/^\s+([a-z-]+):\s*(write|admin)\s*$/gmi)]
    .map((match) => [match[1], match[2].toLowerCase()]);
  assert.deepEqual(writePermissions, [["statuses", "write"]]);
  const actions = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
  assert.deepEqual(actions, ["actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3"]);
  assert.match(workflow, /permissions:\s*\{\}/);
  assert.match(workflow, /pull-requests:\s*read/);
  assert.match(workflow, /issues:\s*read/);
  assert.match(workflow, /contents:\s*read/);
});

test("mastery governance protects its own controls and old names of renamed files", async () => {
  const codeowners = readFileSync(".github/CODEOWNERS", "utf8");
  for (const protectedPath of MASTERY_GOVERNANCE_PROTECTED_FILES) {
    assert.ok(workflow.includes(`"${protectedPath}"`), `${protectedPath} must be protected by the workflow`);
    assert.ok(codeowners.includes(`/${protectedPath}`), `${protectedPath} must have a CODEOWNER`);
  }
  for (const protectedPrefix of MASTERY_GOVERNANCE_PROTECTED_PREFIXES) {
    assert.ok(workflow.includes(`"${protectedPrefix}"`), `${protectedPrefix} must be protected by the workflow`);
    assert.ok(codeowners.includes(`/${protectedPrefix}`), `${protectedPrefix} must have a CODEOWNER`);
  }

  await assert.rejects(
    executeWorkflowScript({ files: [{ filename: "docs/archive.md", previous_filename: ".github/CODEOWNERS" }] }),
    /without the owner-controlled 'mastery-approved' label/,
  );

  const multiPageRename: PullFile[] = Array.from({ length: 101 }, (_, index) => ({ filename: `fixtures/renamed-${index}.txt` }));
  multiPageRename[0].previous_filename = ".github/CODEOWNERS";
  assert.deepEqual(
    (await executeWorkflowScript({ files: multiPageRename, labels: ["mastery-approved"] })).requestedPages,
    [1, 2],
  );
});

test("mastery governance inspects protected paths beyond the old 1000-file boundary", async () => {
  const files = Array.from({ length: 1100 }, (_, index) => ({ filename: `fixtures/file-${index}.txt` }));
  files.push({ filename: "content/path-to-mastery.json" });
  const result = await executeWorkflowScript({ files, labels: ["mastery-approved"] });
  assert.deepEqual(result.requestedPages, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test("mastery governance fails closed on incomplete or unsupported pagination", async () => {
  const files = Array.from({ length: 1101 }, (_, index) => ({ filename: `fixtures/file-${index}.txt` }));
  await assert.rejects(
    executeWorkflowScript({
      files,
      pageOverride: (page, entries) => page === 11 ? entries.slice(0, 50) : entries,
    }),
    /pagination was incomplete on page 11/,
  );
  await assert.rejects(
    executeWorkflowScript({ files: [], changedFileCount: 3001 }),
    /cannot prove completeness for 3001 changed files/,
  );
});

test("mastery governance allows unprotected changes but requires current approval for protected changes", async () => {
  await executeWorkflowScript({ files: [{ filename: "app/page.tsx" }] });
  await assert.rejects(
    executeWorkflowScript({ files: [{ filename: ".github/workflows/another.yml" }] }),
    /without the owner-controlled 'mastery-approved' label/,
  );
  await executeWorkflowScript({
    files: [{ filename: ".github/workflows/another.yml" }],
    labels: ["Documentation", "MASTERY-APPROVED"],
  });

  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  assert.doesNotMatch(ci, /scripts\/check-mastery-governance\.ts/);
});

test("mastery approval is applied only by an authorized actor to the exact current head", async () => {
  const result = await executeWorkflowScript({
    files: [{ filename: "content/path-to-mastery.json" }],
    labels: ["mastery-approved"],
    action: "labeled",
    actorPermission: "write",
  });
  assert.deepEqual(result.createdStatuses, [{
    id: 1000,
    context: "rangabot/mastery-approval",
    state: "success",
  }]);
  assert.equal(result.createdStatusRequests[0]?.sha, currentHeadSha);

  await assert.rejects(
    executeWorkflowScript({
      files: [{ filename: "content/path-to-mastery.json" }],
      labels: ["mastery-approved"],
      action: "labeled",
      actorPermission: "read",
    }),
    /not an authorized write or admin maintainer/,
  );
  await assert.rejects(
    executeWorkflowScript({
      files: [{ filename: "content/path-to-mastery.json" }],
      labels: ["mastery-approved"],
      action: "labeled",
      eventHeadSha: staleHeadSha,
    }),
    /targeted a stale pull-request head/,
  );
});

test("pushing a new commit invalidates the prior mastery approval receipt", async () => {
  await assert.rejects(
    executeWorkflowScript({
      files: [{ filename: "content/path-to-mastery.json" }],
      labels: ["mastery-approved"],
      statuses: [],
    }),
    /not approved for current head/,
  );

  await executeWorkflowScript({
    files: [{ filename: "content/path-to-mastery.json" }],
    labels: ["mastery-approved"],
    action: "labeled",
  });
});

test("the latest approval-label lifecycle actor remains authoritative", async () => {
  await assert.rejects(
    executeWorkflowScript({
      files: [{ filename: "content/path-to-mastery.json" }],
      labels: ["mastery-approved"],
      actorPermission: "read",
      issueEvents: [
        { id: 1, event: "labeled", created_at: "2026-08-10T00:00:00.000Z", label: { name: "mastery-approved" }, actor: { login: "maintainer" } },
        { id: 2, event: "unlabeled", created_at: "2026-08-10T00:01:00.000Z", label: { name: "mastery-approved" }, actor: { login: "outsider" } },
        { id: 3, event: "labeled", created_at: "2026-08-10T00:02:00.000Z", label: { name: "mastery-approved" }, actor: { login: "outsider" } },
      ],
    }),
    /not an authorized write or admin maintainer/,
  );
});

test("mastery governance fails closed when approval metadata cannot be completely paged", async () => {
  const tooManyEvents: IssueEvent[] = Array.from({ length: 3000 }, (_, index) => ({
    id: index + 1,
    event: "commented",
    created_at: new Date(index * 1000).toISOString(),
  }));
  await assert.rejects(
    executeWorkflowScript({
      files: [{ filename: "content/path-to-mastery.json" }],
      labels: ["mastery-approved"],
      issueEvents: tooManyEvents,
    }),
    /cannot prove complete issue-event metadata beyond 3000 records/,
  );
});
