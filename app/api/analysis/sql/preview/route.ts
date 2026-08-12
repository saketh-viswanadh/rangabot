import { NextResponse } from "next/server";
import { createSqlExecutionPreview } from "@/lib/sql-confirmations";
import { StaleProfileRequestError, withProfileRequest } from "@/lib/profile-request";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    return await withProfileRequest(request, { kind: "dataset-processing", label: "SQL preview" }, async () => {
      const body = (await request.json()) as { datasetId?: unknown; query?: unknown };
      if (typeof body.datasetId !== "string" || typeof body.query !== "string") return NextResponse.json({ error: "A dataset approval and SQL query are required." }, { status: 400 });
      return NextResponse.json({ preview: await createSqlExecutionPreview(body.datasetId, body.query) });
    });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not create the SQL preview." }, { status: error instanceof StaleProfileRequestError ? 409 : 400 }); }
}
