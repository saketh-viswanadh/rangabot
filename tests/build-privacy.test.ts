import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("production builds disable framework telemetry through a portable launcher", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const launcher = readFileSync(new URL("../scripts/build.ts", import.meta.url), "utf8");
  assert.equal(packageJson.scripts?.build, "node --experimental-strip-types scripts/build.ts");
  assert.match(launcher, /NEXT_TELEMETRY_DISABLED/);
  assert.match(launcher, /\?\? "1"/);
  assert.doesNotMatch(packageJson.scripts?.build ?? "", /(?:^|\s)next build(?:\s|$)/);
});
