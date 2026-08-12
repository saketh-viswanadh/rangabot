import { NextResponse } from "next/server";
import { currentProfileSessionBinding, profileStatusDto } from "@/lib/profile-context";
import { recoverProfileLifecycle } from "@/lib/profile-lifecycle";
import { recoveryProfileBindingFromRequest } from "@/lib/profile-request";
import { bindResponseToProfileSession } from "@/lib/profile-session-response";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    if (Object.keys(body).sort().join(",") !== "confirmed,expectedGeneration"
      || body.confirmed !== true || !Number.isSafeInteger(body.expectedGeneration)) {
      throw new Error("Explicit profile registry Recovery confirmation is required.");
    }
    recoveryProfileBindingFromRequest(request);
    const recovery = recoverProfileLifecycle({ confirmed: true, expectedGeneration: body.expectedGeneration as number });
    return bindResponseToProfileSession(
      NextResponse.json({ profiles: profileStatusDto(), recovery, message: "Profile Recovery completed locally." }),
      currentProfileSessionBinding(),
    );
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Profile registry Recovery did not complete." }, { status: 409 });
  }
}
