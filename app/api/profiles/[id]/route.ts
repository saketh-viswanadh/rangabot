import { NextResponse } from "next/server";
import { deleteProfile, profileScopePreview, renameProfile } from "@/lib/profile-lifecycle";
import { currentProfileSessionBinding, profileStatusDto } from "@/lib/profile-context";
import { bindResponseToProfileSession } from "@/lib/profile-session-response";
import { profileBindingFromRequest, StaleProfileRequestError } from "@/lib/profile-request";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const id = (await context.params).id;
    profileBindingFromRequest(request);
    return NextResponse.json(profileScopePreview(id));
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Profile scope could not be reviewed." }, { status: error instanceof StaleProfileRequestError ? 409 : 404 }); }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const body = await request.json() as Record<string, unknown>;
    if (Object.keys(body).sort().join(",") !== "displayName,expectedGeneration"
      || typeof body.displayName !== "string" || !Number.isSafeInteger(body.expectedGeneration)) throw new Error("A valid profile rename is required.");
    const profileId = (await context.params).id;
    profileBindingFromRequest(request);
    renameProfile({ profileId, displayName: body.displayName, expectedGeneration: body.expectedGeneration as number });
    return bindResponseToProfileSession(NextResponse.json({ profiles: profileStatusDto() }), currentProfileSessionBinding());
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "The profile was not renamed." }, { status: 409 }); }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const body = await request.json() as Record<string, unknown>;
    if (Object.keys(body).sort().join(",") !== "confirmedName,expectedGeneration"
      || typeof body.confirmedName !== "string" || !Number.isSafeInteger(body.expectedGeneration)) throw new Error("Exact-name deletion confirmation is required.");
    const profileId = (await context.params).id;
    profileBindingFromRequest(request);
    const result = deleteProfile({ profileId, confirmedName: body.confirmedName, expectedGeneration: body.expectedGeneration as number });
    return bindResponseToProfileSession(NextResponse.json({ profiles: profileStatusDto(), cleanupPending: result.cleanupPending }), currentProfileSessionBinding());
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "The profile was not deleted." }, { status: 409 }); }
}
