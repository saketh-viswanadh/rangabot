import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("publishes usable model choices with hardware and license guidance", () => {
  const registry = JSON.parse(readFileSync("config/models.json", "utf8")) as {
    verifiedAt?: string;
    models?: Array<Record<string, unknown>>;
    embeddingModels?: Array<Record<string, unknown>>;
  };
  assert.match(registry.verifiedAt ?? "", /^\d{4}-\d{2}-\d{2}$/);
  assert.ok((registry.models?.length ?? 0) >= 3);
  for (const model of registry.models ?? []) {
    for (const field of ["id", "label", "tier", "minimumMemoryGb", "downloadSize", "uses", "upstream", "licenseReview"]) {
      assert.ok(model[field], `model is missing ${field}`);
    }
  }
  assert.ok((registry.embeddingModels?.length ?? 0) >= 1);
});

test("keeps private runtime and Knowledge Vault material ignored", () => {
  const ignore = readFileSync(".gitignore", "utf8");
  for (const entry of [".env.local", "data/*.db", "data/knowledge/inbox/", "data/knowledge/indexes/", "data/knowledge/backups/"]) {
    assert.ok(ignore.includes(entry), `${entry} must remain ignored`);
  }
});
