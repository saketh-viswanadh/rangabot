import { NextResponse } from "next/server";
import { completeJsonWithOllama } from "@/lib/providers/ollama";
import { buildWordDraftPrompt, createWordArtifact, parseWordDraft, validateWordBrief } from "@/lib/word-documents";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { brief?: unknown };
    const brief = validateWordBrief(body.brief);
    const rawDraft = await completeJsonWithOllama([
      { role: "system", content: "You are Rangabot's local professional document writer. Return valid JSON only. Be faithful to the supplied notes, concise, practical, and explicit about assumptions." },
      { role: "user", content: buildWordDraftPrompt(brief) },
    ]);
    const draft = parseWordDraft(rawDraft);
    const artifact = await createWordArtifact(brief, draft);
    return NextResponse.json({
      artifact: {
        ...artifact,
        documentUrl: `/api/artifacts/word/${artifact.id}/document`,
        previewUrls: Array.from({ length: artifact.previewPages }, (_, index) => `/api/artifacts/word/${artifact.id}/preview/${index + 1}`),
      },
    }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not create the Word document.";
    const status = /required|supported|choose|invalid document structure|section needs/.test(message.toLowerCase()) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
