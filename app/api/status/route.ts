import { NextResponse } from "next/server";
import { getOllamaStatus } from "@/lib/providers/ollama";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(await getOllamaStatus());
}
