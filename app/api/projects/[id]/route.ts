import { NextResponse } from "next/server";
import { updateProject } from "@/lib/conversations";
import { deleteProjectWhenIdle } from "@/lib/conversation-mutation-guards";
import { StaleProfileRequestError, withProfileRequest } from "@/lib/profile-request";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(request: Request, context: RouteContext) {
  try {
    return await withProfileRequest(request, { kind: "database-mutation", label: "project update" }, async () => {
      const body = (await request.json()) as { name?: unknown };
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name || name.length > 60) return NextResponse.json({ error: "A project name between 1 and 60 characters is required." }, { status: 400 });
      const project = updateProject((await context.params).id, name);
      return project ? NextResponse.json({ project }) : NextResponse.json({ error: "Project not found." }, { status: 404 });
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The project was not updated." }, { status: error instanceof StaleProfileRequestError ? 409 : 500 });
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    return await withProfileRequest(request, { kind: "database-mutation", label: "project deletion" }, async () => {
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
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The project was not deleted." }, { status: error instanceof StaleProfileRequestError ? 409 : 500 });
  }
}
