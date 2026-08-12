import { NextResponse } from "next/server";
import { getRuntimeResponseFeedbackCandidate } from "@/lib/response-feedback-candidate";

export const runtime = "nodejs";

export async function GET() {
  const candidate = getRuntimeResponseFeedbackCandidate();
  return NextResponse.json({
    state: candidate.state,
    candidateBuildId: candidate.candidateBuildId,
    build: candidate.build,
    baseCommit: candidate.baseCommit,
    manifestSha256: candidate.manifestSha256,
    artifactSha256: candidate.artifactSha256,
    sourceVersion: candidate.sourceVersion,
  });
}
