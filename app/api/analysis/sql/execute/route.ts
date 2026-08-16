import { NextResponse } from "next/server";
import { executeConfirmedSql } from "@/lib/sql-confirmations";
import { StaleProfileRequestError, withProfileRequest } from "@/lib/profile-request";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    return await withProfileRequest(request, { kind: "dataset-processing", label: "SQL execution" }, async () => {
      const body = (await request.json()) as { confirmationId?: unknown; token?: unknown; datasetId?: unknown; query?: unknown };
      if (typeof body.confirmationId !== "string" || typeof body.token !== "string" || typeof body.datasetId !== "string" || typeof body.query !== "string") {
        return NextResponse.json({ error: "The exact SQL preview confirmation is required." }, { status: 400 });
      }
      return NextResponse.json({ result: await executeConfirmedSql(body as { confirmationId: string; token: string; datasetId: string; query: string }) });
    });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "The SQL execution failed." }, { status: error instanceof StaleProfileRequestError ? 409 : 400 }); }
}
