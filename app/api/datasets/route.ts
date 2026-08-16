import { NextResponse } from "next/server";
import { approveDataset, listApprovedDatasets } from "@/lib/datasets";
import { assertProfileAcceptsExternalUserData, profileBindingFromRequest, StaleProfileRequestError, withProfileRequest } from "@/lib/profile-request";

export const runtime = "nodejs";

function browserDataset(dataset: ReturnType<typeof approveDataset>) {
  const { id, name, format, sizeBytes, addedAt } = dataset;
  return { id, name, format, sizeBytes, addedAt };
}

export function GET(request: Request) {
  try {
    profileBindingFromRequest(request);
    return NextResponse.json({ datasets: listApprovedDatasets().map(browserDataset) });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not read dataset approvals." }, { status: error instanceof StaleProfileRequestError ? 409 : 500 }); }
}

export async function POST(request: Request) {
  try {
    return await withProfileRequest(request, { kind: "database-mutation", label: "dataset approval update" }, async () => {
      assertProfileAcceptsExternalUserData();
      const body = (await request.json()) as { path?: unknown };
      if (typeof body.path !== "string") return NextResponse.json({ error: "An absolute CSV, Parquet, or DuckDB path is required." }, { status: 400 });
      return NextResponse.json({ dataset: browserDataset(approveDataset(body.path)) }, { status: 201 });
    });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not approve this dataset." }, { status: error instanceof StaleProfileRequestError ? 409 : 400 }); }
}
