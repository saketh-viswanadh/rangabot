import { NextResponse } from "next/server";
import { listConversations } from "@/lib/conversations";
import { profileBindingFromRequest, StaleProfileRequestError } from "@/lib/profile-request";

export const runtime = "nodejs";

export function GET(request: Request) {
  try {
    profileBindingFromRequest(request);
    const parameters = new URL(request.url).searchParams;
    const query = (parameters.get("query") ?? "").slice(0, 120);
    const projectId = parameters.get("projectId");
    return NextResponse.json({ conversations: listConversations({ query, projectId }) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Conversations could not be read." }, { status: error instanceof StaleProfileRequestError ? 409 : 500 });
  }
}
