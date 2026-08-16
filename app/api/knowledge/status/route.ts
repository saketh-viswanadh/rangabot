import { NextResponse } from "next/server";
import { getKnowledgeStatus } from "@/lib/knowledge";
import { profileBindingFromRequest, StaleProfileRequestError } from "@/lib/profile-request";

export const runtime = "nodejs";
export function GET(request: Request) {
  try {
    profileBindingFromRequest(request);
    return NextResponse.json(getKnowledgeStatus());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Knowledge status could not be read." }, { status: error instanceof StaleProfileRequestError ? 409 : 500 });
  }
}
