import { NextResponse } from "next/server";
import { revokeDataset } from "@/lib/datasets";
import { StaleProfileRequestError, withProfileRequest } from "@/lib/profile-request";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, context: RouteContext) {
  try {
    return await withProfileRequest(request, { kind: "database-mutation", label: "dataset approval update" }, async () => (
      revokeDataset((await context.params).id) ? new Response(null, { status: 204 })
        : NextResponse.json({ error: "Dataset approval not found." }, { status: 404 })
    ));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not revoke dataset approval." }, { status: error instanceof StaleProfileRequestError ? 409 : 500 });
  }
}
