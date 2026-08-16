import { NextResponse } from "next/server";
import { createProject, listProjects } from "@/lib/conversations";
import { profileBindingFromRequest, StaleProfileRequestError, withProfileRequest } from "@/lib/profile-request";

export const runtime = "nodejs";

export function GET(request: Request) {
  try {
    profileBindingFromRequest(request);
    return NextResponse.json({ projects: listProjects() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Projects could not be read." }, { status: error instanceof StaleProfileRequestError ? 409 : 500 });
  }
}

export async function POST(request: Request) {
  try {
    return await withProfileRequest(request, { kind: "database-mutation", label: "project creation" }, async () => {
      const body = (await request.json()) as { name?: unknown };
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name || name.length > 60) return NextResponse.json({ error: "A project name between 1 and 60 characters is required." }, { status: 400 });
      return NextResponse.json({ project: createProject(name) }, { status: 201 });
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The project was not created." }, { status: error instanceof StaleProfileRequestError ? 409 : 500 });
  }
}
