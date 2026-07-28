import { NextResponse } from "next/server";
import { getAllowedRepository } from "@/lib/repositories";
import { previewRepositoryFile } from "@/lib/repository-search";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  const repository = getAllowedRepository((await context.params).id);
  if (!repository) return NextResponse.json({ error: "Repository approval not found." }, { status: 404 });
  const parameters = new URL(request.url).searchParams;
  try {
    return NextResponse.json({ preview: previewRepositoryFile(repository, parameters.get("path") ?? "", Number(parameters.get("line") ?? 1)) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "File preview failed." }, { status: 400 });
  }
}
