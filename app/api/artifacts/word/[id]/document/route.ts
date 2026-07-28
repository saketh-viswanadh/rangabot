import { readFileSync } from "node:fs";
import { NextResponse } from "next/server";
import { readArtifactMetadata, resolveArtifactFile } from "@/lib/word-documents";

export const runtime = "nodejs";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
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
}
