import { NextResponse } from "next/server";
import { searchKnowledge } from "@/lib/knowledge";

export const runtime = "nodejs";
export async function POST(request: Request) {
  const body = (await request.json()) as { query?: unknown };
  if (typeof body.query !== "string" || !body.query.trim()) return NextResponse.json({ error: "A query is required." }, { status: 400 });
  return NextResponse.json({ results: await searchKnowledge(body.query, 8) });
}
