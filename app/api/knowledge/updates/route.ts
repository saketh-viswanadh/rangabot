import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { NextResponse } from "next/server";
import { knowledgeRoot } from "@/lib/knowledge";

export const runtime = "nodejs";

async function readPath(path: string) {
  try {
    const [content, details] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    return { content, updatedAt: details.mtime.toISOString() };
  } catch {
    return { content: "No report is available yet.", updatedAt: null };
  }
}

async function readReport(name: string) {
  return readPath(resolve(knowledgeRoot, name));
}

export async function GET() {
  const [week, month, changelog] = await Promise.all([
    readReport("NEW_THIS_WEEK.md"),
    readReport("NEW_THIS_MONTH.md"),
    readPath(resolve(knowledgeRoot, "..", "..", "CHANGELOG.md")),
  ]);
  return NextResponse.json({
    week: week.content,
    month: month.content,
    changelog: changelog.content,
    weekUpdatedAt: week.updatedAt,
  });
}
