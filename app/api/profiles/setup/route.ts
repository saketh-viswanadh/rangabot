import { NextResponse } from "next/server";
import { initializeDefaultProfile } from "@/lib/profile-lifecycle";
import { currentProfileSessionBinding, profileStatusDto } from "@/lib/profile-context";
import { bindResponseToProfileSession } from "@/lib/profile-session-response";
import { profileBindingFromRequest } from "@/lib/profile-request";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    if (Object.keys(body).sort().join(",") !== "confirmed" || body.confirmed !== true) {
      throw new Error("Explicit Default profile setup confirmation is required.");
    }
    profileBindingFromRequest(request);
    const result = initializeDefaultProfile({ confirmed: true });
    return bindResponseToProfileSession(NextResponse.json({ profiles: profileStatusDto(), message: result.message }), currentProfileSessionBinding());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Profiles could not be set up. Your original RangaBot data was not replaced. You can retry or continue with the previous setup." }, { status: 409 });
  }
}
