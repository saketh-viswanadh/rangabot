import { NextResponse } from "next/server";
import { knowledgeInbox } from "@/lib/knowledge";
import { importKnowledgeDocuments, KnowledgeImportError } from "@/lib/knowledge-import";
import { ensurePrivateDirectory } from "@/lib/private-storage";
import { assertProfileAcceptsExternalUserData, StaleProfileRequestError, withProfileRequest } from "@/lib/profile-request";
import { ingestKnowledge } from "@/scripts/ingest-knowledge";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    return await withProfileRequest(request, { kind: "indexing", label: "knowledge import" }, async () => {
      assertProfileAcceptsExternalUserData();
      const body = await request.json() as { paths?: unknown };
      if (!Array.isArray(body.paths) || !body.paths.length || body.paths.length > 20 || body.paths.some((path) => typeof path !== "string")) {
        return NextResponse.json({ error: "Choose between 1 and 20 supported documents." }, { status: 400 });
      }
      ensurePrivateDirectory(knowledgeInbox);
      try {
        return NextResponse.json(await importKnowledgeDocuments({
          paths: body.paths as string[],
          knowledgeInbox,
          ingest: ingestKnowledge,
        }));
      } catch (error) {
        if (error instanceof KnowledgeImportError) {
          return NextResponse.json({
            error: error.message,
            phase: error.phase,
            copied: error.copied,
            retained: error.retained,
            outcomes: error.outcomes,
            partial: error.retained.length > 0,
          }, { status: error.phase === "preflight" ? 400 : 500 });
        }
        throw error;
      }
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Documents could not be imported." }, { status: error instanceof StaleProfileRequestError ? 409 : 500 });
  }
}
