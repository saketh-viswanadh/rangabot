import { readFileSync } from "node:fs";
import { NextResponse } from "next/server";
import { readArtifactMetadata, resolveArtifactFile } from "@/lib/word-documents";

export const runtime = "nodejs";

export async function GET(_: Request, context: { params: Promise<{ id: string; page: string }> }) {
  const { id, page } = await context.params;
  const pageNumber = Number(page);
  const metadata = readArtifactMetadata(id);
  if (!metadata || !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > metadata.artifact.previewPages) return NextResponse.json({ error: "Preview not found." }, { status: 404 });
  const path = resolveArtifactFile(id, `preview-${pageNumber}.png`);
  if (!path) return NextResponse.json({ error: "Preview not found." }, { status: 404 });
  return new Response(readFileSync(path), { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}
