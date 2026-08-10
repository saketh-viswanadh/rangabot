import { NextResponse } from "next/server";
import { listConversations } from "@/lib/conversations";

export const runtime = "nodejs";

export function GET(request: Request) {
  const parameters = new URL(request.url).searchParams;
  const query = (parameters.get("query") ?? "").slice(0, 120);
  const projectId = parameters.get("projectId");
  return NextResponse.json({ conversations: listConversations({ query, projectId }) });
}
