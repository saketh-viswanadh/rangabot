import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  collectResponseFeedbackCandidateFiles,
  inspectResponseFeedbackCandidate,
  requireKnownResponseFeedbackCandidate,
  responseFeedbackCandidateEnvironment,
  writeResponseFeedbackBuildArtifactManifest,
} from "../lib/response-feedback-candidate.ts";
import { runtimePaths } from "../lib/runtime-paths.ts";

const candidate = inspectResponseFeedbackCandidate();
const sourceBuildId = candidate.state === "known" ? undefined : `source-${createHash("sha256")
  .update(JSON.stringify(collectResponseFeedbackCandidateFiles()))
  .digest("hex")
  .slice(0, 24)}`;
const nextCli = runtimePaths.nextCli;
const result = spawnSync(process.execPath, [nextCli, "build"], {
  cwd: runtimePaths.resourceRoot,
  env: responseFeedbackCandidateEnvironment({
    ...process.env,
    NEXT_TELEMETRY_DISABLED: process.env.NEXT_TELEMETRY_DISABLED ?? "1",
    ...(sourceBuildId ? { RANGABOT_SOURCE_BUILD_ID: sourceBuildId } : {}),
  }) as NodeJS.ProcessEnv,
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.signal) {
  console.error(`Rangabot's production build was stopped by ${result.signal}.`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}

if (result.status === 0 && !result.signal && candidate.state === "known") {
  const artifact = writeResponseFeedbackBuildArtifactManifest();
  requireKnownResponseFeedbackCandidate({ requireBuildArtifact: true });
  console.log(`Verified Rangabot build artifact ${artifact.artifactSha256}.`);
} else if (result.status === 0 && !result.signal) {
  console.log(`Built non-candidate Rangabot source ${sourceBuildId}; response feedback remains disabled.`);
}
