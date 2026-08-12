import { NextResponse } from "next/server";
import { switchProfile } from "@/lib/profile-lifecycle";
import { currentProfileSessionBinding, profileStatusDto } from "@/lib/profile-context";
import { bindResponseToProfileSession } from "@/lib/profile-session-response";
import { profileBindingFromRequest } from "@/lib/profile-request";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const body = await request.json() as Record<string, unknown>;
    if (Object.keys(body).join(",") !== "expectedGeneration" || !Number.isSafeInteger(body.expectedGeneration)) throw new Error("A valid profile generation is required.");
    const profileId = (await context.params).id;
    profileBindingFromRequest(request);
    switchProfile({ profileId, expectedGeneration: body.expectedGeneration as number });
    return bindResponseToProfileSession(NextResponse.json({ profiles: profileStatusDto(), message: "Profile switch complete." }), currentProfileSessionBinding());
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "The profile was not switched." }, { status: 409 }); }
}
