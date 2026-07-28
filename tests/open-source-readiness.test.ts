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

test("validation never deletes the live Next.js output directory", () => {
  const cleaner = readFileSync("scripts/clean-generated.ts", "utf8");
  assert.doesNotMatch(cleaner, /rmSync\(generated\s*,\s*\{\s*recursive:\s*true/);
  assert.match(cleaner, /stale duplicate Next\.js type/);
});

test("publishes separate code, artwork, and naming terms", () => {
  assert.match(readFileSync("package.json", "utf8"), /Apache-2\.0/);
  assert.match(readFileSync("public/ranga/LICENSE.md", "utf8"), /CC BY 4\.0/);
  assert.match(readFileSync("public/ranga/README.md", "utf8"), /asset provenance/i);
  assert.match(readFileSync("BRANDING.md", "utf8"), /distinct product name/i);
});

test("records upstream licensing without redistributing starter books", () => {
  const manifest = JSON.parse(readFileSync("data/knowledge/SOURCE_MANIFEST.json", "utf8")) as { sources: Array<{ licenseUrl?: string; distributionPolicy?: string }> };
  assert.ok(manifest.sources.length > 0);
  for (const source of manifest.sources) {
    assert.match(source.licenseUrl ?? "", /^https:\/\//);
    assert.match(source.distributionPolicy ?? "", /local-download-only/);
  }
});

test("keeps public demo content synthetic and free of local paths", () => {
  const page = readFileSync("app/page.tsx", "utf8");
  assert.match(page, /demo.*knowledge/);
  assert.match(page, /NumPy 2\.5/);
  assert.doesNotMatch(page, /\/Users\//);
});

test("keeps private runtime and Knowledge Vault material ignored", () => {
  const ignore = readFileSync(".gitignore", "utf8");
  for (const entry of [".env.local", "data/*.db", "data/knowledge/inbox/", "data/knowledge/indexes/", "data/knowledge/backups/"]) {
    assert.ok(ignore.includes(entry), `${entry} must remain ignored`);
  }
});
