import { NextResponse } from "next/server";
import { resetTestingProfile } from "@/lib/profile-lifecycle";
import { currentProfileSessionBinding, profileStatusDto } from "@/lib/profile-context";
import { bindResponseToProfileSession } from "@/lib/profile-session-response";
import { profileBindingFromRequest } from "@/lib/profile-request";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const body = await request.json() as Record<string, unknown>;
    if (Object.keys(body).sort().join(",") !== "confirmedName,expectedGeneration"
      || typeof body.confirmedName !== "string" || !Number.isSafeInteger(body.expectedGeneration)) throw new Error("Exact-name reset confirmation is required.");
    const profileId = (await context.params).id;
    profileBindingFromRequest(request);
    const result = resetTestingProfile({ profileId, confirmedName: body.confirmedName, expectedGeneration: body.expectedGeneration as number });
    return bindResponseToProfileSession(NextResponse.json({ profiles: profileStatusDto(), cleanupPending: result.cleanupPending }), currentProfileSessionBinding());
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "The Testing profile was not reset." }, { status: 409 }); }
}
