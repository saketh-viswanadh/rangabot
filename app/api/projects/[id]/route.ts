import { NextResponse } from "next/server";
import { deleteProject, updateProject } from "@/lib/conversations";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(request: Request, context: RouteContext) {
  const body = (await request.json()) as { name?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 60) return NextResponse.json({ error: "A project name between 1 and 60 characters is required." }, { status: 400 });
  const project = updateProject((await context.params).id, name);
  return project ? NextResponse.json({ project }) : NextResponse.json({ error: "Project not found." }, { status: 404 });
}

export async function DELETE(_request: Request, context: RouteContext) {
  return deleteProject((await context.params).id)
    ? new Response(null, { status: 204 })
    : NextResponse.json({ error: "Project not found." }, { status: 404 });
}
