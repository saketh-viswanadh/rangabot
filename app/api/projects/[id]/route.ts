import { NextResponse } from "next/server";
import { updateProject } from "@/lib/conversations";
import { deleteProjectWhenIdle } from "@/lib/conversation-mutation-guards";

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
  const result = deleteProjectWhenIdle((await context.params).id);
  if (result === "turn-in-progress") {
    return NextResponse.json({
      error: "Stop or finish active turns before deleting this project.",
      code: "turn-in-progress",
    }, { status: 409 });
  }
  return result === "deleted"
    ? new Response(null, { status: 204 })
    : NextResponse.json({ error: "Project not found." }, { status: 404 });
}
