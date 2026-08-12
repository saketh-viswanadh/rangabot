import { NextResponse } from "next/server";
import { revokeRepository } from "@/lib/repositories";
import { StaleProfileRequestError, withProfileRequest } from "@/lib/profile-request";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, context: RouteContext) {
  try {
    return await withProfileRequest(request, { kind: "database-mutation", label: "repository approval update" }, async () => (
      revokeRepository((await context.params).id)
        ? new Response(null, { status: 204 })
        : NextResponse.json({ error: "Allowed repository not found." }, { status: 404 })
    ));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not update the repository allowlist." }, { status: error instanceof StaleProfileRequestError ? 409 : 500 });
  }
}
