import { NextResponse } from "next/server";
import { getOllamaStatus } from "@/lib/providers/ollama";
import { StaleProfileRequestError, withProfileRequest } from "@/lib/profile-request";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    return await withProfileRequest(request, { kind: "tool-execution", label: "local model status check" }, async () => (
      NextResponse.json(await getOllamaStatus())
    ));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The local model status could not be read." }, { status: error instanceof StaleProfileRequestError ? 409 : 503 });
  }
}
