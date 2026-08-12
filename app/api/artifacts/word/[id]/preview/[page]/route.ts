import { readFileSync } from "node:fs";
import { NextResponse } from "next/server";
import { readArtifactMetadata, resolveArtifactFile } from "@/lib/word-documents";
import { StaleProfileRequestError, withProfileRequest } from "@/lib/profile-request";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string; page: string }> }) {
  try {
    return await withProfileRequest(request, { kind: "export", label: "Word document preview" }, async () => {
      const { id, page } = await context.params;
      const pageNumber = Number(page);
      const metadata = readArtifactMetadata(id);
      if (!metadata || !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > metadata.artifact.previewPages) return NextResponse.json({ error: "Preview not found." }, { status: 404 });
      const path = resolveArtifactFile(id, `preview-${pageNumber}.png`);
      if (!path) return NextResponse.json({ error: "Preview not found." }, { status: 404 });
      return new Response(readFileSync(path), { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The preview could not be read." }, { status: error instanceof StaleProfileRequestError ? 409 : 500 });
  }
}
