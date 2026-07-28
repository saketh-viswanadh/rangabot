import { NextResponse } from "next/server";
import { getKnowledgeStatus } from "@/lib/knowledge";

export const runtime = "nodejs";
export function GET() { return NextResponse.json(getKnowledgeStatus()); }
