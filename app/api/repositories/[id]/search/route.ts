import { NextResponse } from "next/server";
import { getAllowedRepository } from "@/lib/repositories";
import { searchRepository } from "@/lib/repository-search";
import { StaleProfileRequestError, withProfileRequest } from "@/lib/profile-request";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    return await withProfileRequest(request, { kind: "tool-execution", label: "repository search" }, async () => {
      const repository = getAllowedRepository((await context.params).id);
      if (!repository) return NextResponse.json({ error: "Repository approval not found." }, { status: 404 });
      const query = new URL(request.url).searchParams.get("query") ?? "";
      return NextResponse.json({ results: searchRepository(repository, query) });
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Repository search failed." }, { status: error instanceof StaleProfileRequestError ? 409 : 400 });
  }
}
