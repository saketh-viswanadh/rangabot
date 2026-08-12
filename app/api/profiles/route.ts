import { NextResponse } from "next/server";
import { createProfile, ProfileBusyError, ProfileLifecycleError } from "@/lib/profile-lifecycle";
import { currentProfileSessionBinding, profileStatusDto } from "@/lib/profile-context";
import { bindResponseToProfileSession } from "@/lib/profile-session-response";
import { profileBindingFromRequest, recoveryProfileBindingFromRequest, StaleProfileRequestError } from "@/lib/profile-request";

export const runtime = "nodejs";

export function GET(request: Request) {
  try {
    const status = profileStatusDto();
    if (status.registryRecoveryRequired || status.recoveryRequired) recoveryProfileBindingFromRequest(request);
    else profileBindingFromRequest(request);
    return NextResponse.json(status, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return NextResponse.json({ error: error instanceof StaleProfileRequestError ? error.message : "The local profile registry could not be read safely." }, { status: error instanceof StaleProfileRequestError ? 409 : 500 }); }
}

function errorResponse(error: unknown) {
  if (error instanceof ProfileBusyError) return NextResponse.json({ error: error.message, operation: error.operation }, { status: 409 });
  if (error instanceof ProfileLifecycleError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.code === "not-found" ? 404 : 409 });
  return NextResponse.json({ error: error instanceof Error ? error.message : "The profile could not be created." }, { status: 400 });
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    if (Object.keys(body).sort().join(",") !== "displayName,expectedGeneration,kind"
      || typeof body.displayName !== "string"
      || (body.kind !== "personal" && body.kind !== "testing")
      || !Number.isSafeInteger(body.expectedGeneration)) throw new Error("A valid profile request is required.");
    profileBindingFromRequest(request);
    const result = createProfile({
      displayName: body.displayName,
      kind: body.kind,
      expectedGeneration: body.expectedGeneration as number,
    });
    return bindResponseToProfileSession(NextResponse.json({ profile: result.profile, profiles: profileStatusDto() }, { status: 201 }), currentProfileSessionBinding());
  } catch (error) {
    if (error instanceof StaleProfileRequestError) return NextResponse.json({ error: error.message }, { status: 409 });
    return errorResponse(error);
  }
}
