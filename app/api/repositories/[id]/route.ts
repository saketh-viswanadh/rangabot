import { NextResponse } from "next/server";
import { revokeRepository } from "@/lib/repositories";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ id: string }> };

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    return revokeRepository((await context.params).id)
      ? new Response(null, { status: 204 })
      : NextResponse.json({ error: "Allowed repository not found." }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not update the repository allowlist." }, { status: 500 });
  }
}
