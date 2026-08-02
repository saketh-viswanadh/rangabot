import { NextResponse } from "next/server";
import { createSqlExecutionPreview } from "@/lib/sql-confirmations";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = (await request.json()) as { datasetId?: unknown; query?: unknown };
  if (typeof body.datasetId !== "string" || typeof body.query !== "string") return NextResponse.json({ error: "A dataset approval and SQL query are required." }, { status: 400 });
  try { return NextResponse.json({ preview: await createSqlExecutionPreview(body.datasetId, body.query) }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not create the SQL preview." }, { status: 400 }); }
}
