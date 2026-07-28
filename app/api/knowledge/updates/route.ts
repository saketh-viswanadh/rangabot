import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { NextResponse } from "next/server";
import { knowledgeRoot } from "@/lib/knowledge";

export const runtime = "nodejs";

async function readReport(name: string) {
  try { return await readFile(resolve(knowledgeRoot, name), "utf8"); } catch { return "No report is available yet."; }
}

export async function GET() {
  const [week, month] = await Promise.all([readReport("NEW_THIS_WEEK.md"), readReport("NEW_THIS_MONTH.md")]);
  return NextResponse.json({ week, month });
}
