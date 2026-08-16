import { NextResponse } from "next/server";
import { getRuntimeResponseFeedbackCandidate } from "@/lib/response-feedback-candidate";
import { profileBindingFromRequest, StaleProfileRequestError } from "@/lib/profile-request";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    profileBindingFromRequest(request);
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
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Runtime identity could not be read." }, { status: error instanceof StaleProfileRequestError ? 409 : 500 });
  }
}
