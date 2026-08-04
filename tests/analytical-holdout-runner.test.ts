import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runAnalyticalHoldout } from "../scripts/analytical-holdout-runner.ts";

test("rejects a broken gold query before any model evaluation", async () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), "rangabot-holdout-"));
  await assert.rejects(runAnalyticalHoldout({
    suite: "preflight-test", frozenAt: "2026-08-03", databaseName: "preflight.duckdb", outputDirectory,
    setupSql: "CREATE TABLE samples AS SELECT 1::INTEGER sample_id;",
    cases: [{ id: "bad-reference", question: "How many samples?", goldSql: "SELECT missing_column FROM samples" }],
  }), /Holdout preflight failed for bad-reference/);
});

test("rejects contradictory boundary fixtures during preflight", async () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), "rangabot-holdout-"));
  await assert.rejects(runAnalyticalHoldout({
    suite: "boundary-test", frozenAt: "2026-08-03", databaseName: "boundary.duckdb", outputDirectory,
    setupSql: "CREATE TABLE samples AS SELECT 1::INTEGER sample_id;",
    cases: [{ id: "bad-boundary", question: "Which sample is best?", boundary: "clarify", goldSql: "SELECT sample_id FROM samples" }],
  }), /Boundary case bad-boundary must not include gold SQL/);
});
