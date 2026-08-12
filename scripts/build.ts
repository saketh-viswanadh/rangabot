import { spawnSync } from "node:child_process";
import {
  requireKnownResponseFeedbackCandidate,
  responseFeedbackCandidateEnvironment,
  writeResponseFeedbackBuildArtifactManifest,
} from "../lib/response-feedback-candidate.ts";
import { runtimePaths } from "../lib/runtime-paths.ts";

requireKnownResponseFeedbackCandidate();
const nextCli = runtimePaths.nextCli;
const result = spawnSync(process.execPath, [nextCli, "build"], {
  cwd: runtimePaths.resourceRoot,
  env: responseFeedbackCandidateEnvironment({
    ...process.env,
    NEXT_TELEMETRY_DISABLED: process.env.NEXT_TELEMETRY_DISABLED ?? "1",
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

if (result.status === 0 && !result.signal) {
  const artifact = writeResponseFeedbackBuildArtifactManifest();
  requireKnownResponseFeedbackCandidate({ requireBuildArtifact: true });
  console.log(`Verified Rangabot build artifact ${artifact.artifactSha256}.`);
}
