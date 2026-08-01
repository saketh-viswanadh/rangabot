import { NextResponse } from "next/server";
import { applyMemoryImport, maxMemoryImportBytes, previewMemoryImport } from "@/lib/memories";

export const runtime = "nodejs";

async function readBoundedBody(request: Request) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxMemoryImportBytes) throw new Error("Memory import exceeds the 300 KB limit.");
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    if (bytes > maxMemoryImportBytes) { await reader.cancel(); throw new Error("Memory import exceeds the 300 KB limit."); }
    text += decoder.decode(value, { stream: true });
  }
}

export async function POST(request: Request) {
  try {
    const text = await readBoundedBody(request);
    const body = JSON.parse(text) as { action?: unknown; export?: unknown; replaceSourceIds?: unknown };
    if (body.action === "preview") return NextResponse.json({ preview: previewMemoryImport(body.export) });
    if (body.action === "apply") return NextResponse.json({ result: applyMemoryImport(body.export, body.replaceSourceIds) });
    throw new Error("Choose preview or apply for the memory import.");
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Memory import failed." }, { status: 400 });
  }
}
