import { NextResponse } from "next/server";
import { getDatasetSemanticMemory, saveDatasetSemanticMemory } from "@/lib/dataset-semantic-contexts";
import { getApprovedDataset } from "@/lib/datasets";
import { profileBindingFromRequest, StaleProfileRequestError, withProfileRequest } from "@/lib/profile-request";
import { inspectDatasetSchema } from "@/lib/sql-runtime";
import type { AnalyticalSemanticContext } from "@/lib/analytical-semantic-context";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ id: string }> };

async function exactDatasetAndSchema(id: string) {
  const dataset = getApprovedDataset(id);
  if (!dataset) return null;
  const columns = await inspectDatasetSchema(dataset.path, { expectedFileIdentity: dataset.fileIdentity, expectedInputSha256: dataset.fileIdentity.sha256 });
  return { dataset, columns };
}

function browserPayload(value: NonNullable<Awaited<ReturnType<typeof exactDatasetAndSchema>>>) {
  const tables = [...new Set(value.columns.map((column) => column.table ?? "dataset"))].sort().map((table) => ({
    table, columns: value.columns.filter((column) => (column.table ?? "dataset") === table).map((column) => ({ name: column.name, type: column.type })),
  }));
  const memory = getDatasetSemanticMemory(value.dataset);
  return {
    dataset: { id: value.dataset.id, name: value.dataset.name }, tables,
    memory: memory ? {
      status: memory.status, updatedAt: memory.updatedAt, context: memory.context,
      learnedUsage: { tables: Object.keys(memory.usage.tables).length, columns: Object.keys(memory.usage.columns).length },
    } : { status: "not-started" as const, context: { version: 1 as const }, learnedUsage: { tables: 0, columns: 0 } },
  };
}

export async function GET(request: Request, context: RouteContext) {
  try {
    profileBindingFromRequest(request);
    const value = await exactDatasetAndSchema((await context.params).id);
    return value ? NextResponse.json(browserPayload(value)) : NextResponse.json({ error: "Dataset approval not found." }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not read the saved dataset context." }, { status: error instanceof StaleProfileRequestError ? 409 : 500 });
  }
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    return await withProfileRequest(request, { kind: "database-mutation", label: "dataset semantic context update" }, async () => {
      const value = await exactDatasetAndSchema((await context.params).id);
      if (!value) return NextResponse.json({ error: "Dataset approval not found." }, { status: 404 });
      const body = (await request.json()) as { status?: unknown; context?: unknown };
      if (body.status !== "skipped" && body.status !== "complete") return NextResponse.json({ error: "Choose whether to save or skip dataset context." }, { status: 400 });
      if (!body.context || typeof body.context !== "object") return NextResponse.json({ error: "Dataset context is required." }, { status: 400 });
      const memory = saveDatasetSemanticMemory({ dataset: value.dataset, columns: value.columns, status: body.status, context: body.context as AnalyticalSemanticContext });
      return NextResponse.json({ memory: { status: memory.status, updatedAt: memory.updatedAt, context: memory.context } });
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save dataset context." }, { status: error instanceof StaleProfileRequestError ? 409 : 400 });
  }
}
