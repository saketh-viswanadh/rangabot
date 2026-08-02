import assert from "node:assert/strict";
import test from "node:test";
import { devServerEnvironment } from "../lib/dev-server.ts";

test("uses bounded polling on macOS to avoid watcher descriptor exhaustion", () => {
  const environment = devServerEnvironment("darwin", { RANGABOT_TEST: "yes" });
  assert.equal(environment.WATCHPACK_POLLING, "true");
  assert.equal(environment.WATCHPACK_POLLING_INTERVAL, "1000");
  assert.equal(environment.RANGABOT_TEST, "yes");
});

test("preserves native file watching on Linux and Windows", () => {
  assert.equal(devServerEnvironment("linux", {}).WATCHPACK_POLLING, undefined);
  assert.equal(devServerEnvironment("win32", {}).WATCHPACK_POLLING, undefined);
});

test("respects an explicit watcher override", () => {
  const environment = devServerEnvironment("darwin", { WATCHPACK_POLLING: "false", WATCHPACK_POLLING_INTERVAL: "2500" });
  assert.equal(environment.WATCHPACK_POLLING, "false");
  assert.equal(environment.WATCHPACK_POLLING_INTERVAL, "2500");
});
