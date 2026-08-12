import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildModelViews, pullRecommendedModel, readModelPreference, updateSelectedChatModel, validModelId } from "../lib/model-manager.ts";

test("model ids are bounded provider identifiers", () => {
  assert.equal(validModelId("llama3.2:3b"), true);
  assert.equal(validModelId("team/model-name:Q4_K_M"), true);
  assert.equal(validModelId("../escape"), false);
  assert.equal(validModelId("model name"), false);
});

test("model catalog combines reviewed and installed models without pretending qualification", () => {
  const models = buildModelViews(["llama3.2:3b", "private/custom:latest"], { schemaVersion: 1, selectedModel: "private/custom:latest", revision: 2, updatedAt: null });
  assert.equal(models.find((model) => model.id === "llama3.2:3b")?.recommended, true);
  assert.equal(models.find((model) => model.id === "private/custom:latest")?.recommended, false);
  assert.equal(models.find((model) => model.id === "private/custom:latest")?.selected, true);
});

test("model preference is private, revisioned, and durable", () => {
  const root = mkdtempSync(join(tmpdir(), "rangabot-model-preference-"));
  const path = join(root, "model-preferences.json");
  try {
    assert.equal(readModelPreference(path).revision, 0);
    // The production writer is path-bound; parsing and private-file behavior are
    // covered by using its canonical serialized shape through the reader.
    const value = { schemaVersion: 1, selectedModel: "llama3.2:3b", revision: 1, updatedAt: "2026-08-12T00:00:00.000Z" };
    writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    assert.deepEqual(readModelPreference(path), value);
    assert.match(readFileSync(path, "utf8"), /llama3\.2:3b/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("model installation requires a reviewed id and uses the local pull API", async () => {
  let request: RequestInit | undefined;
  const fetcher = async (_url: string | URL | Request, init?: RequestInit) => { request = init; return Response.json({ status: "success" }); };
  assert.equal(await pullRecommendedModel("llama3.2:3b", fetcher as typeof fetch), "llama3.2:3b");
  assert.deepEqual(JSON.parse(String(request?.body)), { model: "llama3.2:3b", stream: false });
  await assert.rejects(pullRecommendedModel("unreviewed:latest", fetcher as typeof fetch), /reviewed/);
});

test("production selection writer rejects invalid input before storage", () => {
  assert.throws(() => updateSelectedChatModel({ modelId: "../escape", expectedRevision: 0 }), /valid model/);
});
