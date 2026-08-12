import { buildBookWelcomeResponse } from "@/lib/knowledge-welcome";
import { profileBindingFromRequest, StaleProfileRequestError } from "@/lib/profile-request";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export function GET(request: Request) {
  try {
    profileBindingFromRequest(request);
    return buildBookWelcomeResponse(request);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Knowledge welcome could not be read." }, { status: error instanceof StaleProfileRequestError ? 409 : 500 });
  }
}
