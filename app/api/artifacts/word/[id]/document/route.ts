import { readFileSync } from "node:fs";
import { NextResponse } from "next/server";
import { readArtifactMetadata, resolveArtifactFile } from "@/lib/word-documents";
import { StaleProfileRequestError, withProfileRequest } from "@/lib/profile-request";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    return await withProfileRequest(request, { kind: "export", label: "Word document download" }, async () => {
      const { id } = await context.params;
      const metadata = readArtifactMetadata(id);
      const path = metadata ? resolveArtifactFile(id, metadata.artifact.filename) : null;
      if (!path || !metadata) return NextResponse.json({ error: "Document not found." }, { status: 404 });
      return new Response(readFileSync(path), {
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "Content-Disposition": `attachment; filename="${metadata.artifact.filename.replaceAll('"', "")}"`,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The document could not be downloaded." }, { status: error instanceof StaleProfileRequestError ? 409 : 500 });
  }
}
