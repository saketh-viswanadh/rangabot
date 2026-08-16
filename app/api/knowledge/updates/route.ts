import { readFile, stat } from "node:fs/promises";
import { NextResponse } from "next/server";
import { knowledgeMonthlyBrief, knowledgeWeeklyBrief } from "@/lib/knowledge";
import { runtimePaths } from "@/lib/runtime-paths";
import { StaleProfileRequestError, withProfileRequest } from "@/lib/profile-request";

export const runtime = "nodejs";

async function readPath(path: string) {
  try {
    const [content, details] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    return { content, updatedAt: details.mtime.toISOString() };
  } catch {
    return { content: "No report is available yet.", updatedAt: null };
  }
}

export async function GET(request: Request) {
  try {
    return await withProfileRequest(request, { kind: "export", label: "Knowledge update read" }, async () => {
      const [week, month, changelog] = await Promise.all([
        readPath(knowledgeWeeklyBrief),
        readPath(knowledgeMonthlyBrief),
        readPath(runtimePaths.changelog),
      ]);
      return NextResponse.json({
        week: week.content,
        month: month.content,
        changelog: changelog.content,
        weekUpdatedAt: week.updatedAt,
      });
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Knowledge updates could not be read." }, { status: error instanceof StaleProfileRequestError ? 409 : 500 });
  }
}
