import { constants, copyFileSync, lstatSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { NextResponse } from "next/server";
import { knowledgeInbox } from "@/lib/knowledge";
import { ensurePrivateDirectory } from "@/lib/private-storage";
import { StaleProfileRequestError, withProfileRequest } from "@/lib/profile-request";
import { ingestKnowledge } from "@/scripts/ingest-knowledge";

export const runtime = "nodejs";
const allowed = new Set([".pdf", ".docx", ".txt", ".md", ".html", ".htm"]);

export async function POST(request: Request) {
  try {
    return await withProfileRequest(request, { kind: "indexing", label: "knowledge import" }, async () => {
      const body = await request.json() as { paths?: unknown };
      if (!Array.isArray(body.paths) || !body.paths.length || body.paths.length > 20 || body.paths.some((path) => typeof path !== "string")) {
        return NextResponse.json({ error: "Choose between 1 and 20 supported documents." }, { status: 400 });
      }
      ensurePrivateDirectory(knowledgeInbox);
      const copied: string[] = [];
      for (const rawPath of body.paths as string[]) {
        const source = resolve(rawPath);
        const status = lstatSync(source);
        const extension = extname(source).toLowerCase();
        if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1 || !allowed.has(extension)) {
          return NextResponse.json({ error: `${basename(source)} is not a supported regular document.` }, { status: 400 });
        }
        const destination = join(knowledgeInbox, basename(source));
        if (resolve(destination) === source) continue;
        copyFileSync(source, destination, constants.COPYFILE_EXCL);
        copied.push(destination);
      }
      const status = await ingestKnowledge();
      return NextResponse.json({ copied: copied.length, status });
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Documents could not be imported." }, { status: error instanceof StaleProfileRequestError ? 409 : 500 });
  }
}
