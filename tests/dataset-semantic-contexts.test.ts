import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DatasetSemanticMemoryConflictError,
  DatasetSemanticMemoryDatasetChangedError,
  getDatasetSemanticMemory,
  recordDatasetSemanticUsage,
  resetDatasetSemanticContextRegistryPathForTests,
  saveDatasetSemanticMemory,
  selectDatasetSemanticContext,
  setDatasetSemanticContextRegistryPathForTests,
  verifiedSqlUsage,
} from "../lib/dataset-semantic-contexts.ts";
import type { ApprovedDataset } from "../lib/datasets.ts";
import type { DatasetColumn } from "../lib/sql-runtime.ts";

const columns: DatasetColumn[] = [
  { table: "customers", name: "customer_id", type: "INTEGER", primaryKey: true },
  { table: "customers", name: "region", type: "VARCHAR" },
  { table: "orders", name: "customer_id", type: "INTEGER" },
  { table: "orders", name: "booked_value", type: "DOUBLE" },
  { table: "orders", name: "ordered_at", type: "DATE" },
];

function dataset(sha = "a".repeat(64)): ApprovedDataset {
  return {
    id: "dataset-a", name: "sales.duckdb", path: "/private/sales.duckdb", format: "duckdb", sizeBytes: 1_024,
    addedAt: "2026-08-23T00:00:00.000Z", approvalVersion: 2,
    fileIdentity: { device: "1", inode: "2", sizeBytes: 1_024, modifiedNs: "3", changedNs: "4", sha256: sha },
  };
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "rangabot-semantic-memory-"));
  const path = join(root, "dataset-semantic-contexts.json");
  setDatasetSemanticContextRegistryPathForTests(path);
  return { root, path, cleanup() { resetDatasetSemanticContextRegistryPathForTests(); rmSync(root, { recursive: true, force: true }); } };
}

test("saves optional semantic onboarding privately and binds it to the exact dataset digest", () => {
  const fixture = sandbox();
  try {
    const saved = saveDatasetSemanticMemory({
      dataset: dataset(), columns, status: "complete", expectedRevision: 0,
      context: {
        version: 1,
        tables: [{ table: "orders", aliases: ["purchases"], description: "One row per customer order." }],
        columns: [{ table: "orders", column: "booked_value", aliases: ["revenue"], description: "Booked order value." }],
        relationships: [{ fromTable: "orders", fromColumn: "customer_id", toTable: "customers", toColumn: "customer_id", confirmed: true }],
        queryEvidence: "This request-only evidence must never persist.",
      },
    });
    assert.equal(saved.revision, 1);
    assert.equal(saved.context.queryEvidence, undefined);
    assert.deepEqual(getDatasetSemanticMemory(dataset())?.context, saved.context);
    assert.equal(getDatasetSemanticMemory(dataset("b".repeat(64))), null);
    assert.doesNotMatch(readFileSync(fixture.path, "utf8"), /request-only evidence/);
    if (process.platform !== "win32") assert.equal(lstatSync(fixture.path).mode & 0o777, 0o600);
  } finally { fixture.cleanup(); }
});

test("rejects context outside the approved schema and does not follow a linked store", { skip: process.platform === "win32" }, () => {
  const fixture = sandbox();
  try {
    assert.throws(() => saveDatasetSemanticMemory({ dataset: dataset(), columns, status: "complete", expectedRevision: 0, context: { version: 1, columns: [{ table: "orders", column: "secret", description: "No." }] } }), /not in the approved schema/);
    const victim = join(fixture.root, "victim.json");
    writeFileSync(victim, JSON.stringify({ version: 1, memories: [] }), { mode: 0o600 });
    symlinkSync(victim, fixture.path);
    assert.throws(() => getDatasetSemanticMemory(dataset()), /context store is damaged/);
    assert.equal(readFileSync(victim, "utf8"), JSON.stringify({ version: 1, memories: [] }));
  } finally { fixture.cleanup(); }
});

test("retrieves a compact request-relevant slice and learns priority only from verified SQL usage", () => {
  const fixture = sandbox();
  try {
    saveDatasetSemanticMemory({
      dataset: dataset(), columns, status: "complete", expectedRevision: 0,
      context: {
        version: 1,
        tables: [{ table: "orders", aliases: ["purchases"] }, { table: "customers", aliases: ["clients"] }],
        columns: [
          { table: "orders", column: "booked_value", aliases: ["revenue"] },
          { table: "customers", column: "region", aliases: ["territory"] },
          { table: "orders", column: "ordered_at", aliases: ["purchase date"] },
        ],
        relationships: [{ fromTable: "orders", fromColumn: "customer_id", toTable: "customers", toColumn: "customer_id", confirmed: true }],
      },
    });
    const focused = selectDatasetSemanticContext("Show revenue by client territory", getDatasetSemanticMemory(dataset()));
    assert.deepEqual(focused?.columns?.map((item) => `${item.table}.${item.column}`).sort(), ["customers.region", "orders.booked_value"]);
    assert.equal(focused?.relationships?.length, 1);

    const usage = verifiedSqlUsage("SELECT c.region, SUM(o.booked_value) FROM customers c JOIN orders o ON o.customer_id = c.customer_id GROUP BY c.region", columns);
    assert.deepEqual(usage.tables, ["customers", "orders"]);
    assert.deepEqual(usage.columns, ["customers.customer_id", "customers.region", "orders.booked_value", "orders.customer_id"]);
    assert.equal(recordDatasetSemanticUsage(dataset(), usage), true);
    const learned = getDatasetSemanticMemory(dataset());
    assert.equal(learned?.usage.tables.orders.count, 1);
    assert.equal(learned?.usage.columns["orders.booked_value"].count, 1);
    const fallback = selectDatasetSemanticContext("Please investigate this", learned);
    assert.ok((fallback?.tables?.length ?? 0) > 0);
  } finally { fixture.cleanup(); }
});

test("skipped onboarding is remembered without sending semantic context to the model", () => {
  const fixture = sandbox();
  try {
    saveDatasetSemanticMemory({ dataset: dataset(), columns, status: "skipped", context: { version: 1 }, expectedRevision: 0 });
    assert.equal(getDatasetSemanticMemory(dataset())?.status, "skipped");
    assert.equal(selectDatasetSemanticContext("show revenue", getDatasetSemanticMemory(dataset())), undefined);
    assert.equal(recordDatasetSemanticUsage(dataset(), { tables: ["orders"], columns: [] }), false);
  } finally { fixture.cleanup(); }
});

test("durable revisions reject stale context writes and preserve the winning bytes", () => {
  const fixture = sandbox();
  try {
    const first = saveDatasetSemanticMemory({
      dataset: dataset(), columns, status: "complete", expectedRevision: 0,
      context: { version: 1, tables: [{ table: "orders", description: "First durable meaning." }] },
    });
    assert.equal(first.revision, 1);
    const winningBytes = readFileSync(fixture.path, "utf8");
    assert.throws(
      () => saveDatasetSemanticMemory({
        dataset: dataset(), columns, status: "complete", expectedRevision: 0,
        context: { version: 1, tables: [{ table: "orders", description: "Stale overwrite." }] },
      }),
      (error: unknown) => error instanceof DatasetSemanticMemoryConflictError && error.currentRevision === 1,
    );
    assert.equal(readFileSync(fixture.path, "utf8"), winningBytes);
    const second = saveDatasetSemanticMemory({
      dataset: dataset(), columns, status: "complete", expectedRevision: 1,
      context: { version: 1, tables: [{ table: "orders", description: "Second durable meaning." }] },
    });
    assert.equal(second.revision, 2);
    assert.equal(getDatasetSemanticMemory(dataset())?.context.tables?.[0].description, "Second durable meaning.");
  } finally { fixture.cleanup(); }
});

test("the final approval re-read blocks a revoked dataset before its CAS write", () => {
  const fixture = sandbox();
  try {
    assert.throws(
      () => saveDatasetSemanticMemory({
        dataset: dataset(), columns, status: "complete", expectedRevision: 0,
        context: { version: 1 }, currentDataset: () => null,
      }),
      (error: unknown) => error instanceof DatasetSemanticMemoryDatasetChangedError,
    );
    assert.equal(getDatasetSemanticMemory(dataset()), null);
  } finally { fixture.cleanup(); }
});

test("pre-revision semantic memory is read as revision one and upgrades on its next CAS", () => {
  const fixture = sandbox();
  try {
    writeFileSync(fixture.path, JSON.stringify({
      version: 1,
      memories: [{
        version: 1, datasetId: dataset().id, datasetSha256: dataset().fileIdentity.sha256,
        status: "skipped", updatedAt: "2026-08-23T00:00:00.000Z", context: { version: 1 },
        usage: { tables: {}, columns: {} },
      }],
    }), { mode: 0o600 });
    assert.equal(getDatasetSemanticMemory(dataset())?.revision, 1);
    const upgraded = saveDatasetSemanticMemory({
      dataset: dataset(), columns, status: "complete", expectedRevision: 1, context: { version: 1 },
    });
    assert.equal(upgraded.revision, 2);
    assert.match(readFileSync(fixture.path, "utf8"), /"revision": 2/);
  } finally { fixture.cleanup(); }
});

test("single-file queries learn the stable dataset table and unqualified columns", () => {
  assert.deepEqual(verifiedSqlUsage("SELECT region, SUM(amount) FROM dataset GROUP BY region", [
    { name: "region", type: "VARCHAR" }, { name: "amount", type: "DOUBLE" },
  ]), { tables: ["dataset"], columns: ["dataset.amount", "dataset.region"] });
});

test("the workspace and API expose optional local context without exposing file identity", () => {
  const panel = readFileSync(new URL("../app/components/sql-analysis-panel.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const revokeCallback = page.slice(page.indexOf("onDatasetRevoked={async"), page.indexOf("initialDraft={sqlDraft}"));
  const route = readFileSync(new URL("../app/api/datasets/[id]/context/route.ts", import.meta.url), "utf8");
  assert.match(panel, /Teach Ranga about this data/);
  assert.match(panel, /never invents or silently changes their meaning/);
  assert.match(panel, /const expectedRevision = contextPayload\.memory\.revision/);
  assert.match(panel, /data\.memory\.revision !== expectedRevision \+ 1/);
  assert.match(panel, /payload\.memory\.status === "complete" \? onClose\(\) : void onSave\("skipped"/);
  assert.match(panel, /const workspaceRequestRef = useRef\(0\)/);
  assert.match(panel, /workspaceRequest !== workspaceRequestRef\.current/);
  assert.match(panel, /const \[workspaceReady, setWorkspaceReady\] = useState\(false\)/);
  assert.match(panel, /workspaceProfileMarker === activeProfileMarker/);
  assert.match(panel, /workspaceCurrent \? datasets\.map/);
  assert.match(panel, /\[activeProfileMarker, closePanel, open, refresh\]/);
  assert.match(panel, /workspaceMutationTailRef\.current\.then\(\(\) => refresh\(workspaceRequest\)\)/);
  assert.match(panel, /const workspaceRequest = workspaceRequestRef\.current;[\s\S]*requestId !== analysisRequestRef\.current \|\| workspaceRequest !== workspaceRequestRef\.current/);
  assert.match(panel, /function isPreview\(/);
  assert.match(panel, /function isResult\(/);
  assert.match(panel, /candidateResult\.receipt\.querySha256 !== expectedQuerySha256/);
  assert.match(panel, /workspaceCurrent && preview/);
  assert.match(panel, /workspaceCurrent && result/);
  assert.match(panel, /SQL execution outcome could not be confirmed[\s\S]*one-time approval was discarded/);
  assert.match(panel, /Nothing was run; review the dataset and query/);
  assert.match(panel, /The approval response was interrupted[\s\S]*authoritative approved-data list/);
  assert.match(panel, /approval response did not match the authoritative approved-data list/);
  assert.match(panel, /The revocation response was interrupted[\s\S]*authoritative approved-data list/);
  assert.match(panel, /still appears in the authoritative approved-data list, so revocation is not confirmed/);
  assert.doesNotMatch(panel, /requested removal from the open chat/);
  assert.match(panel, /const bindingResult = !stillApproved \? await onDatasetRevoked\?\.\(dataset\.id\) : undefined/);
  assert.match(panel, /bindingResult === "detached"[\s\S]*open chat no longer uses it/);
  assert.match(panel, /bindingResult === "not-bound"[\s\S]*currently open chat did not require a binding change/);
  assert.match(page, /onDatasetRevoked=\{async \(datasetId\) => \{[\s\S]*?targetDatasetId !== datasetId[\s\S]*?const detached = await attachDatasetToChat\(null\)[\s\S]*?return detached \? "detached" : "unconfirmed"/);
  assert.match(page, /dataset approval was revoked, but this chat's saved binding could not be confirmed/);
  assert.match(page, /activeConversationIdRef\.current !== targetConversationId[\s\S]*conversationOpenEpochRef\.current !== renderedConversationEpoch/);
  assert.match(page, /attachedDatasetRef\.current\?\.id === datasetId[\s\S]*return "unconfirmed"/);
  assert.ok(revokeCallback.indexOf("activeConversationIdRef.current !== targetConversationId") < revokeCallback.indexOf('if (targetDatasetId !== datasetId) return "not-bound"'));
  assert.ok(revokeCallback.lastIndexOf("activeConversationIdRef.current !== targetConversationId") > revokeCallback.indexOf("const detached = await attachDatasetToChat(null)"));
  assert.match(page, /currentBinding\.datasetSha256 !== targetBinding\.datasetSha256/);
  assert.match(panel, /Reload saved context before trying again/);
  assert.match(panel, /contextPayload\.memory\.revision/);
  assert.match(panel, /The save outcome could not be confirmed/);
  assert.match(panel, /className="sql-reject" disabled=\{busy \|\| !workspaceCurrent\}/);
  assert.match(route, /dataset semantic context update/);
  assert.match(route, /kind: "dataset-processing", label: "dataset semantic context read"/);
  assert.match(route, /inspectDatasetSchema[\s\S]*signal/);
  assert.match(route, /expectedRevision/);
  assert.match(route, /revision-conflict/);
  assert.match(route, /currentDataset: \(\) => getApprovedDataset\(id\)/);
  assert.doesNotMatch(route, /fileIdentity:\s*value\.dataset\.fileIdentity/);
});
