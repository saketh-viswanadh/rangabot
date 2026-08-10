import { NextResponse } from "next/server";
import { allowRepository, listAllowedRepositories } from "@/lib/repositories";

export const runtime = "nodejs";

function browserRepository(repository: ReturnType<typeof allowRepository>) {
  const { id, name, path, addedAt } = repository;
  return { id, name, path, addedAt };
}

export function GET() {
  try {
    return NextResponse.json({ repositories: listAllowedRepositories().map(browserRepository) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not read the repository allowlist." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const body = (await request.json()) as { path?: unknown };
  if (typeof body.path !== "string") return NextResponse.json({ error: "An absolute folder path is required." }, { status: 400 });
  try {
    return NextResponse.json({ repository: browserRepository(allowRepository(body.path)) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not allow this folder." }, { status: 400 });
  }
}
