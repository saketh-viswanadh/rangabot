import assert from "node:assert/strict";
import test from "node:test";
import {
  devServerEnvironment,
  localBootstrapUrl,
  localServerEnvironment,
  localServerPort,
} from "../lib/dev-server.ts";
import { verifyExpectedLocalBootstrapToken } from "../lib/local-session-token.ts";

test("creates a fresh private session secret and disables framework telemetry", () => {
  const first = localServerEnvironment({});
  const second = localServerEnvironment({});
  assert.match(first.RANGABOT_SESSION_SECRET ?? "", /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.RANGABOT_SESSION_SECRET, second.RANGABOT_SESSION_SECRET);
  assert.match(first.RANGABOT_BOOTSTRAP_TOKEN ?? "", /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(verifyExpectedLocalBootstrapToken(
    first.RANGABOT_BOOTSTRAP_TOKEN,
    first.RANGABOT_SESSION_SECRET ?? "",
    first.RANGABOT_BOOTSTRAP_TOKEN,
  ), true);
  assert.notEqual(first.RANGABOT_BOOTSTRAP_TOKEN, second.RANGABOT_BOOTSTRAP_TOKEN);
  assert.equal(first.NEXT_TELEMETRY_DISABLED, "1");
});

test("prints a fragment-bound bootstrap URL for the configured local port", () => {
  const environment = localServerEnvironment({ PORT: "4312" });
  const token = environment.RANGABOT_BOOTSTRAP_TOKEN ?? "";
  const url = localBootstrapUrl(token, localServerPort(environment));
  assert.match(url, /^http:\/\/127\.0\.0\.1:4312\/bootstrap#bootstrap=/);
  assert.equal(new URL(url).search, "");
  assert.equal(localServerPort({}), 3000);
  assert.throws(() => localServerPort({ PORT: "80" }), /between 1024 and 65535/);
  assert.throws(() => localServerPort({ PORT: "not-a-port" }), /between 1024 and 65535/);
});

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
