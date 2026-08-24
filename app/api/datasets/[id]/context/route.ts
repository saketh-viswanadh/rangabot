import { NextResponse } from "next/server";
import {
  DatasetSemanticMemoryConflictError,
  DatasetSemanticMemoryDatasetChangedError,
  getDatasetSemanticMemory,
  saveDatasetSemanticMemory,
} from "@/lib/dataset-semantic-contexts";
import { getApprovedDataset } from "@/lib/datasets";
import { StaleProfileRequestError, withProfileRequest } from "@/lib/profile-request";
import { inspectDatasetSchema } from "@/lib/sql-runtime";
import type { AnalyticalSemanticContext } from "@/lib/analytical-semantic-context";
import type { ApprovedDataset } from "@/lib/datasets";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ id: string }> };

function sameApproval(left: ApprovedDataset | null, right: ApprovedDataset) {
  return Boolean(left && left.id === right.id && left.name === right.name && left.path === right.path
    && left.format === right.format && left.sizeBytes === right.sizeBytes && left.addedAt === right.addedAt
    && left.approvalVersion === right.approvalVersion
    && left.fileIdentity.device === right.fileIdentity.device
    && left.fileIdentity.inode === right.fileIdentity.inode
    && left.fileIdentity.sizeBytes === right.fileIdentity.sizeBytes
    && left.fileIdentity.modifiedNs === right.fileIdentity.modifiedNs
    && left.fileIdentity.changedNs === right.fileIdentity.changedNs
    && left.fileIdentity.sha256 === right.fileIdentity.sha256);
}

async function exactDatasetAndSchema(id: string, signal: AbortSignal) {
  const dataset = getApprovedDataset(id);
  if (!dataset) return null;
  const columns = await inspectDatasetSchema(dataset.path, {
    expectedFileIdentity: dataset.fileIdentity,
    expectedInputSha256: dataset.fileIdentity.sha256,
    signal,
  });
  const current = getApprovedDataset(id);
  if (!sameApproval(current, dataset)) throw new DatasetSemanticMemoryDatasetChangedError();
  return { dataset: current!, columns };
}

function browserPayload(value: NonNullable<Awaited<ReturnType<typeof exactDatasetAndSchema>>>) {
  const tables = [...new Set(value.columns.map((column) => column.table ?? "dataset"))].sort().map((table) => ({
    table, columns: value.columns.filter((column) => (column.table ?? "dataset") === table).map((column) => ({ name: column.name, type: column.type })),
  }));
  const memory = getDatasetSemanticMemory(value.dataset);
  return {
    dataset: { id: value.dataset.id, name: value.dataset.name }, tables,
    memory: memory ? {
      revision: memory.revision, status: memory.status, updatedAt: memory.updatedAt, context: memory.context,
      learnedUsage: { tables: Object.keys(memory.usage.tables).length, columns: Object.keys(memory.usage.columns).length },
    } : { revision: 0, status: "not-started" as const, context: { version: 1 as const }, learnedUsage: { tables: 0, columns: 0 } },
  };
}

export async function GET(request: Request, context: RouteContext) {
  try {
    return await withProfileRequest(request, { kind: "dataset-processing", label: "dataset semantic context read", cancellable: true }, async (signal) => {
      const value = await exactDatasetAndSchema((await context.params).id, signal);
      return value ? NextResponse.json(browserPayload(value)) : NextResponse.json({ error: "Dataset approval not found." }, { status: 404 });
    });
  } catch (error) {
    const status = error instanceof StaleProfileRequestError || error instanceof DatasetSemanticMemoryDatasetChangedError ? 409
      : error instanceof DOMException && error.name === "AbortError" ? 499 : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not read the saved dataset context." }, { status });
  }
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    return await withProfileRequest(request, { kind: "database-mutation", label: "dataset semantic context update" }, async (signal) => {
      const body = (await request.json()) as { status?: unknown; context?: unknown; expectedRevision?: unknown };
      if (!body || typeof body !== "object" || Array.isArray(body)
        || !Object.keys(body).every((key) => ["status", "context", "expectedRevision"].includes(key))) {
        return NextResponse.json({ error: "A bounded dataset context update is required." }, { status: 400 });
      }
      if (body.status !== "skipped" && body.status !== "complete") return NextResponse.json({ error: "Choose whether to save or skip dataset context." }, { status: 400 });
      if (!body.context || typeof body.context !== "object") return NextResponse.json({ error: "Dataset context is required." }, { status: 400 });
      if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0) {
        return NextResponse.json({ error: "The authoritative dataset context revision is required." }, { status: 400 });
      }
      const id = (await context.params).id;
      const value = await exactDatasetAndSchema(id, signal);
      if (!value) return NextResponse.json({ error: "Dataset approval not found." }, { status: 404 });
      const memory = saveDatasetSemanticMemory({
        dataset: value.dataset,
        columns: value.columns,
        status: body.status,
        context: body.context as AnalyticalSemanticContext,
        expectedRevision: Number(body.expectedRevision),
        // This final approval read is synchronous with the storage CAS and
        // prevents a concurrent revoke from resurrecting semantic memory.
        currentDataset: () => getApprovedDataset(id),
      });
      return NextResponse.json({ memory: { revision: memory.revision, status: memory.status, updatedAt: memory.updatedAt, context: memory.context } });
    });
  } catch (error) {
    if (error instanceof DatasetSemanticMemoryConflictError) {
      return NextResponse.json({ error: error.message, code: "revision-conflict", currentRevision: error.currentRevision }, { status: 409 });
    }
    const status = error instanceof StaleProfileRequestError || error instanceof DatasetSemanticMemoryDatasetChangedError ? 409
      : error instanceof DOMException && error.name === "AbortError" ? 499 : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save dataset context." }, { status });
  }
}
