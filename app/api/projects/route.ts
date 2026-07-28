import { NextResponse } from "next/server";
import { createProject, listProjects } from "@/lib/conversations";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json({ projects: listProjects() });
}

export async function POST(request: Request) {
  const body = (await request.json()) as { name?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 60) return NextResponse.json({ error: "A project name between 1 and 60 characters is required." }, { status: 400 });
  return NextResponse.json({ project: createProject(name) }, { status: 201 });
}
