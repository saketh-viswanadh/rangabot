import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import nextConfig from "../next.config.ts";

test("globally disables image optimization and excludes the complete Sharp runtime from tracing", () => {
  assert.equal(nextConfig.images?.unoptimized, true);
  const excludes = nextConfig.outputFileTracingExcludes as Record<string, string[]>;
  assert.deepEqual(excludes["/*"], [
    "./tests/**/*",
    "./node_modules/sharp/**/*",
    "./node_modules/@img/**/*",
  ]);
  assert.deepEqual(excludes["next-server"], [
    "./node_modules/sharp/**/*",
    "./node_modules/@img/**/*",
  ]);
});

test("mastery preserves its governed brand mark and keeps contributor images explicitly unoptimized", () => {
  const mastery = readFileSync("app/mastery/page.tsx", "utf8");
  assert.match(mastery, /<PrimaryBrandMark className="core-mark" large/);
  assert.match(mastery, /contributor\.avatar \? <Image src=\{contributor\.avatar\}[^>]+unoptimized/);
  assert.doesNotMatch(mastery, /\/_next\/image|https?:\/\/[^"'`]*\.(?:png|jpe?g|webp|avif)/i);
});

test("desktop staging fails closed on Sharp packages, native modules, or libvips libraries", () => {
  const prepare = readFileSync("scripts/prepare-desktop.ts", "utf8");
  assert.match(prepare, /function assertNoBrokenSharpPayload\(files: readonly DesktopArtifactFile\[\]\)/);
  assert.match(prepare, /node_modules\\\/\(\?:sharp\|@img\)/);
  assert.match(prepare, /sharp\[\^\/\]\*\\\.node/);
  assert.match(prepare, /libvips\[\^\/\]\*\\\.\(\?:dylib\|so\|dll\)/);
  assert.ok(prepare.indexOf("assertNoBrokenSharpPayload(resources)") > prepare.indexOf("const resources = collectDesktopArtifactFiles(resourceRoot)"));
});
