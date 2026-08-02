import { NextResponse } from "next/server";
import { revokeDataset } from "@/lib/datasets";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ id: string }> };

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    return revokeDataset((await context.params).id) ? new Response(null, { status: 204 })
      : NextResponse.json({ error: "Dataset approval not found." }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not revoke dataset approval." }, { status: 500 });
  }
}
