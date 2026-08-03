import { NextResponse } from "next/server";
import { approveDataset, listApprovedDatasets } from "@/lib/datasets";

export const runtime = "nodejs";

export function GET() {
  try { return NextResponse.json({ datasets: listApprovedDatasets() }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not read dataset approvals." }, { status: 500 }); }
}

export async function POST(request: Request) {
  const body = (await request.json()) as { path?: unknown };
  if (typeof body.path !== "string") return NextResponse.json({ error: "An absolute CSV, Parquet, or DuckDB path is required." }, { status: 400 });
  try { return NextResponse.json({ dataset: approveDataset(body.path) }, { status: 201 }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not approve this dataset." }, { status: 400 }); }
}
