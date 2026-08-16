import { spawn } from "node:child_process";
import { devServerEnvironment, localBootstrapUrl, localServerPort } from "../lib/dev-server.ts";
import { maintainSqlConfirmationStoreAtPath } from "../lib/sql-confirmation-store.ts";
import { purgeArtifactDeletionQuarantine } from "../lib/conversation-artifacts.ts";
import { assertProfileSessionBindingCurrent, currentProfileSessionBinding } from "../lib/profile-context.ts";
import { requireNoProfileRecovery } from "../lib/profile-recovery.ts";
import { acquireRuntimeLease } from "../lib/runtime-lease.ts";
import { responseFeedbackCandidateEnvironment } from "../lib/response-feedback-candidate.ts";
import { runtimePaths } from "../lib/runtime-paths.ts";

const serverEnvironment = responseFeedbackCandidateEnvironment(devServerEnvironment(process.platform));
const serverPort = localServerPort(serverEnvironment);
const bootstrapToken = serverEnvironment.RANGABOT_BOOTSTRAP_TOKEN;
if (!bootstrapToken) throw new Error("Could not create Rangabot's private startup capability.");

requireNoProfileRecovery(runtimePaths.managedDataRoot);
const startupProfileBinding = currentProfileSessionBinding();
const runtimeLease = acquireRuntimeLease({ role: "app" });

try {
  requireNoProfileRecovery(runtimePaths.managedDataRoot);
  assertProfileSessionBindingCurrent(startupProfileBinding);
} catch (error) {
  runtimeLease.release();
  throw error;
}

let sqlConfirmationMaintenanceSucceeded = false;
try {
  maintainSqlConfirmationStoreAtPath(runtimePaths.sqlConfirmations);
  sqlConfirmationMaintenanceSucceeded = true;
} catch (error) {
  console.warn(`Private storage maintenance could not complete: ${error instanceof Error ? error.message : "unknown local storage error"}`);
}
if (sqlConfirmationMaintenanceSucceeded) {
  try {
    requireNoProfileRecovery(runtimePaths.managedDataRoot);
    assertProfileSessionBindingCurrent(startupProfileBinding);
  } catch (error) {
    runtimeLease.release();
    throw error;
  }
  try {
    purgeArtifactDeletionQuarantine(runtimePaths.artifactsRoot);
  } catch (error) {
    console.warn(`Private storage maintenance could not complete: ${error instanceof Error ? error.message : "unknown local storage error"}`);
  }
}

const nextCli = runtimePaths.nextCli;
if (serverEnvironment.RANGABOT_CANDIDATE_STATE !== "known") {
  console.warn(`Response feedback is disabled because candidate identity is ${serverEnvironment.RANGABOT_CANDIDATE_STATE ?? "unknown"}.`);
}
console.log(`\nOpen Rangabot using this private one-launch URL:\n${localBootstrapUrl(bootstrapToken, serverPort)}\n`);
const child = spawn(process.execPath, [nextCli, "dev", "--hostname", "127.0.0.1", "--port", String(serverPort)], {
  cwd: runtimePaths.resourceRoot,
  env: serverEnvironment as NodeJS.ProcessEnv,
  stdio: "inherit",
});

if (child.pid) {
  try { runtimeLease.registerRuntimeProcess(child.pid); }
  catch (error) {
    child.kill("SIGTERM");
    console.error(error instanceof Error ? error.message : "Could not register the private Rangabot runtime.");
    process.exitCode = 1;
  }
}

const forwardedSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
const signalHandlers = new Map<NodeJS.Signals, () => void>();
for (const signal of forwardedSignals) {
  const handler = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  signalHandlers.set(signal, handler);
  process.once(signal, handler);
}

const detachSignalHandlers = () => {
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
};

// If the supervisor dies unexpectedly while Next is still alive, preserve the
// lease. Its recorded child PID prevents rollback from treating it as stale.
process.once("exit", () => {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) runtimeLease.release();
});

child.once("error", (error) => {
  console.error(`Could not start Rangabot: ${error.message}`);
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) runtimeLease.release();
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  detachSignalHandlers();
  runtimeLease.release();
  process.exitCode = signal ? 1 : (code ?? 1);
});
